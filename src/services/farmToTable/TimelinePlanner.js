// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\TimelinePlanner.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead TimelinePlanner
 * -----------------------------------------------------------------------------
 * Builds a unified, dated timeline (milestones + recommended work sessions) from:
 *  - provisioning targets + gaps
 *  - garden targets
 *  - animal targets
 *  - preservation batch suggestions
 *  - gap action recommendations (buy/plant/breed/process/substitute/schedule)
 *  - feasibility constraints (capacity, season windows, lead times)
 *
 * Output is UI-ready for:
 *  - Homestead Planner "Timeline" view (if/when added)
 *  - Homestead KPI row (next due targets)
 *  - Schedule/Session deep-links ("Create session" payloads)
 *
 * Deterministic + explainable. No AI.
 *
 * -----------------------------------------------------------------------------
 * Input
 * -----------------------------------------------------------------------------
 * planTimeline({
 *   householdId,
 *   startISO,
 *   horizonDays,
 *   timezone, // optional: "America/Chicago"
 *   catalogBundle,          // optional, used for labels/tags
 *
 *   // Primary sources (any subset):
 *   targetsOutput,          // ProvisioningTargetEngine output (optional)
 *   gardenTargetsOutput,    // GardenTargetBuilder output (optional)
 *   animalTargetsOutput,    // AnimalTargetBuilder output (optional)
 *   gapActionsOutput,       // GapActionRecommender output (optional)
 *   feasibilityReport,      // FeasibilityChecker output (optional)
 *
 *   // Capacity/equipment profiles (optional):
 *   equipmentProfile,       // { capacities:{...} }
 *
 *   options
 * })
 *
 * -----------------------------------------------------------------------------
 * Output
 * -----------------------------------------------------------------------------
 * {
 *   meta,
 *   timeline: {
 *     startISO,
 *     endISO,
 *     items: TimelineItem[],
 *     sessions: SessionSuggestion[],
 *     milestones: TimelineItem[], // subset
 *   },
 *   next: {
 *     dueISO,
 *     items: TimelineItem[], // top 5 next due
 *     sessions: SessionSuggestion[], // top 3
 *   },
 *   issues: { blockers[], risks[] },
 *   trace: { notes[], rulesApplied[] }
 * }
 *
 * TimelineItem:
 * {
 *   id,
 *   dateISO,               // primary scheduled date (UTC ISO)
 *   endISO?,               // optional duration window
 *   domain: "storehouse"|"garden"|"animals"|"preservation"|"cooking"|"shopping"|"planning",
 *   kind: "milestone"|"task"|"reminder"|"window",
 *   title,
 *   detail,
 *   priority: 1..5,
 *   confidence: 0..1,
 *   tags: string[],
 *   links?: { to, payload },
 *   dependsOn?: string[],  // timeline item ids
 *   explain?: string[]
 * }
 *
 * SessionSuggestion (for SSA session planner / SessionRunner):
 * {
 *   id,
 *   domainKey,             // e.g. "garden_care", "animals_care", "preservation", "storehouse", "cleaning", "cooking"
 *   title,
 *   startISO,              // recommended start
 *   durationMin,
 *   steps: [{ title, minutes?, meta? }],
 *   links: { to, payload }, // typically /play or /schedule with session template payload
 *   priority: 1..5,
 *   confidence: 0..1,
 *   tags: string[],
 *   explain: string[]
 * }
 */

const SOURCE = "services/farmToTable/TimelinePlanner";

const DEFAULTS = {
  maxTimelineItems: 600,
  maxSessions: 120,

  // Default cadence rules for scheduling sessions
  cadence: {
    shopping: { durationMin: 45, leadDays: 2 },
    garden: { durationMin: 60, leadDays: 3 },
    animals: { durationMin: 45, leadDays: 3 },
    preservation: { durationMin: 120, leadDays: 5 },
    planning: { durationMin: 25, leadDays: 1 },
  },

  // If an item has byISO, schedule on/by that date; else place within lead days
  defaultDueLeadDays: 7,

  // Priorities mapping
  priority: {
    high: 5,
    medium: 3,
    low: 2,
  },

  // Ranking weights for "next"
  nextRanking: {
    soon: 0.55,
    priority: 0.3,
    confidence: 0.15,
  },

  // Time bucketing for UI
  buckets: {
    today: 0,
    soonDays: 7,
    upcomingDays: 21,
  },

  // Session step templates
  templates: {
    shopping: [
      "Review list",
      "Check inventory on-hand",
      "Bulk/scan compare",
      "Purchase & record",
      "Put away + update inventory",
    ],
    garden: [
      "Review planting targets",
      "Check weather/soil readiness",
      "Prep beds/containers",
      "Plant/sow",
      "Water + log",
    ],
    animals: [
      "Review animal targets",
      "Check housing/feed",
      "Source/purchase or plan breeding",
      "Health check",
      "Log updates",
    ],
    preservation: [
      "Review batch plan",
      "Prep equipment + sanitize",
      "Process",
      "Label + store",
      "Update inventory + notes",
    ],
    planning: [
      "Review gaps + targets",
      "Confirm capacities",
      "Pick top actions",
      "Schedule sessions",
      "Save plan snapshot",
    ],
  },

  // Domain mapping for action types
  actionDomainMap: {
    buy: { domain: "shopping", domainKey: "storehouse" },
    plant: { domain: "garden", domainKey: "garden_planning" },
    breed: { domain: "animals", domainKey: "animals_acquisition" },
    process: { domain: "preservation", domainKey: "preservation" },
    substitute: { domain: "planning", domainKey: "storehouse" },
    schedule: { domain: "planning", domainKey: "storehouse" },
    research: { domain: "planning", domainKey: "storehouse" },
  },

  // When feasibility is blocked, elevate planning sessions
  blockedFeasibilityBoost: true,
};

export const TimelinePlanner = {
  planTimeline,
  summarize,
  rankTimelineItems,
  rankSessions,
};

/* -----------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------- */

export function planTimeline(input = {}) {
  const opts = mergeOptions(input.options);

  const householdId = safeStr(input.householdId || "primary");
  const startISO = input.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : input.targetsOutput?.meta?.horizonDays || 28;
  const timezone = safeStr(input.timezone || "America/Chicago");
  const endISO = addDaysISO(startISO, horizonDays);

  const feasibility = input.feasibilityReport || null;

  const rulesApplied = [];
  const notes = [];
  const blockers = [];
  const risks = [];

  // Roll up issues from upstream reports if present
  collectIssues(blockers, risks, input.targetsOutput);
  collectIssues(blockers, risks, input.gardenTargetsOutput);
  collectIssues(blockers, risks, input.animalTargetsOutput);
  collectIssues(blockers, risks, feasibility);

  const timelineItems = [];
  const sessions = [];

  // 1) Feasibility-first planning session (optional boost)
  if (
    opts.blockedFeasibilityBoost &&
    feasibility?.feasibilityStatus === "blocked"
  ) {
    sessions.push(
      buildPlanningSession({
        startISO,
        opts,
        priority: 5,
        confidence: 0.9,
        title: "Restore feasibility (scope + capacity)",
        explain: [
          "Feasibility is blocked; resolve constraints first.",
          "Shorten horizon, reduce targets, or add capacity before committing to work sessions.",
        ],
      })
    );
    rulesApplied.push(
      "Feasibility blocked: added high-priority planning session."
    );
  }

  // 2) Convert provisioning targets to milestones (optional)
  timelineItems.push(
    ...buildProvisioningMilestones(
      input.targetsOutput,
      startISO,
      endISO,
      opts,
      rulesApplied
    )
  );

  // 3) Convert garden targets into planting windows + sessions
  const gOut = input.gardenTargetsOutput || null;
  if (Array.isArray(gOut?.targets) && gOut.targets.length) {
    const { items, sessionSuggestions } = buildGardenTimeline(
      gOut.targets,
      startISO,
      endISO,
      opts,
      rulesApplied
    );
    timelineItems.push(...items);
    sessions.push(...sessionSuggestions);
  }

  // 4) Convert animal targets into acquisition/breeding timeline + sessions
  const aOut = input.animalTargetsOutput || null;
  if (Array.isArray(aOut?.targets) && aOut.targets.length) {
    const { items, sessionSuggestions } = buildAnimalTimeline(
      aOut.targets,
      startISO,
      endISO,
      opts,
      rulesApplied
    );
    timelineItems.push(...items);
    sessions.push(...sessionSuggestions);
  }

  // 5) Convert gap actions to timeline items + sessions
  const gaOut = input.gapActionsOutput || null;
  if (Array.isArray(gaOut?.actions) && gaOut.actions.length) {
    const { items, sessionSuggestions } = buildActionsTimeline(
      gaOut.actions,
      startISO,
      endISO,
      opts,
      rulesApplied
    );
    timelineItems.push(...items);
    sessions.push(...sessionSuggestions);
  }

  // 6) Add "review & save plan" reminder near the end of horizon
  timelineItems.push({
    id: `milestone:review:${hashTiny(
      `${householdId}|${startISO}|${horizonDays}`
    )}`,
    dateISO: addDaysISO(endISO, -1),
    domain: "planning",
    kind: "reminder",
    title: "Review outcomes & roll plan forward",
    detail:
      "Close loops: update inventory, mark targets completed, refresh gaps, and start the next cycle.",
    priority: 3,
    confidence: 0.8,
    tags: ["planning", "cycle"],
    links: { to: "/homesteadplanner/targets", payload: { focus: "review" } },
    explain: ["End-of-cycle reminder supports weekly/biweekly cadence."],
  });

  // De-dupe, clamp to horizon, rank
  const normalizedItems = normalizeTimelineItems(
    timelineItems,
    startISO,
    endISO,
    opts.maxTimelineItems
  );
  const normalizedSessions = normalizeSessions(
    sessions,
    startISO,
    endISO,
    opts.maxSessions
  );

  const rankedItems = rankTimelineItems(normalizedItems, startISO, opts);
  const rankedSessions = rankSessions(normalizedSessions, startISO, opts);

  const milestones = rankedItems.filter(
    (x) => x.kind === "milestone" || x.kind === "window"
  );

  const next = computeNext(rankedItems, rankedSessions, startISO, opts);

  notes.push(`Timeline built for ${horizonDays} days in timezone ${timezone}.`);

  return {
    meta: {
      householdId,
      startISO,
      endISO,
      horizonDays,
      timezone,
      builtAtISO: new Date().toISOString(),
      source: SOURCE,
    },
    timeline: {
      startISO,
      endISO,
      items: rankedItems,
      sessions: rankedSessions,
      milestones,
    },
    next,
    issues: { blockers: rankIssues(blockers), risks: rankIssues(risks) },
    trace: { notes, rulesApplied: uniq(rulesApplied) },
  };
}

export function summarize(out) {
  const o = out || {};
  const items = o.timeline?.items || [];
  const sessions = o.timeline?.sessions || [];
  const nextDue = o.next?.dueISO ? formatDateShort(o.next.dueISO) : "n/a";
  return [
    `Timeline items: ${items.length} • Sessions: ${sessions.length}`,
    `Next due: ${nextDue}`,
    `Blockers: ${(o.issues?.blockers || []).length} • Risks: ${
      (o.issues?.risks || []).length
    }`,
  ];
}

/* -----------------------------------------------------------------------------
 * Builders
 * --------------------------------------------------------------------------- */

function buildProvisioningMilestones(
  targetsOutput,
  startISO,
  endISO,
  opts,
  rulesApplied
) {
  const out = [];
  const prov = Array.isArray(targetsOutput?.provisioning)
    ? targetsOutput.provisioning
    : [];
  if (!prov.length) return out;

  // If provisioning items include byISO, use it; else distribute at midpoint
  for (const p of prov) {
    const qty = toNum(p.qty, 0);
    if (qty <= 0) continue;

    const byISO =
      p.byISO ||
      addDaysISO(startISO, Math.round(daysBetweenISO(startISO, endISO) / 2));
    out.push({
      id: `milestone:prov:${safeStr(p.componentId)}:${hashTiny(
        `${p.componentId}|${qty}|${p.unit}|${byISO}`
      )}`,
      dateISO: byISO,
      domain: "storehouse",
      kind: "milestone",
      title: `Provision ${safeStr(p.name || p.componentName || p.componentId)}`,
      detail: `Target: ${fmtQty(qty)} ${normalizeUnit(
        p.unit || "each"
      )} by ${formatDateShort(byISO)}.`,
      priority: 3,
      confidence: 0.7,
      tags: ["provisioning", `cat:${safeStr(p.category || "unknown")}`],
      links: {
        to: "/homesteadplanner/targets",
        payload: { componentId: p.componentId },
      },
      explain: [
        "Provisioning milestone derived from ProvisioningTargetEngine output.",
      ],
    });
  }

  rulesApplied.push("Converted provisioning targets to milestones.");
  return out;
}

function buildGardenTimeline(
  gardenTargets,
  startISO,
  endISO,
  opts,
  rulesApplied
) {
  const items = [];
  const sessionSuggestions = [];

  for (const t of gardenTargets) {
    const ideal = t.timing?.idealStartISO || startISO;
    const latest = t.timing?.latestStartISO || ideal;
    const cropName = safeStr(t.cropName || t.componentName || "Crop");
    const componentName = safeStr(
      t.componentName || t.componentId || "Component"
    );

    // Planting window item
    items.push({
      id: `window:garden:${safeStr(t.id || `${t.componentId}|${t.cropId}`)}`,
      dateISO: ideal,
      endISO: latest,
      domain: "garden",
      kind: "window",
      title: `Plant window: ${cropName}`,
      detail: `Derived from ${componentName}. Plan ${fmtQty(
        t.planting?.sqft
      )} sqft, ${t.planting?.plants} plants.`,
      priority: t.timing?.withinSeason === false ? 2 : 4,
      confidence: clampNum(toNum(t.confidence, 0.6), 0, 1),
      tags: uniq([
        "garden",
        "planting",
        t.timing?.withinSeason === false ? "season:warning" : "season:ok",
      ]),
      links: t.links || {
        to: "/homesteadplanner/garden-targets",
        payload: { componentId: t.componentId, cropId: t.cropId },
      },
      explain: [
        "Planting window based on crop lead time to maturity.",
        t.timing?.withinSeason === false
          ? "May be out of season; adjust crop or timing."
          : "Within season window (if provided).",
      ],
    });

    // Recommended garden session placed near ideal date
    sessionSuggestions.push(
      buildSessionFromTarget({
        domain: "garden",
        domainKey: "garden_planning",
        title: `Garden: plant ${cropName}`,
        startISO: clampToRange(addDaysISO(ideal, -1), startISO, endISO),
        durationMin: opts.cadence.garden.durationMin,
        steps: opts.templates.garden.map((s) => ({
          title: s,
          meta: { componentId: t.componentId, cropId: t.cropId },
        })),
        priority: t.timing?.withinSeason === false ? 2 : 4,
        confidence: clampNum(toNum(t.confidence, 0.6), 0, 1),
        tags: ["garden", "planting", `crop:${toLower(cropName)}`],
        explain: [
          `Planting target derived from gardenTargetsOutput for ${componentName}.`,
        ],
        links: {
          to: "/play",
          payload: {
            domainKey: "garden_planning",
            title: `Garden: plant ${cropName}`,
            derivedFrom: "TimelinePlanner",
            meta: {
              componentId: t.componentId,
              cropId: t.cropId,
              planting: t.planting,
              timing: t.timing,
            },
          },
        },
      })
    );
  }

  rulesApplied.push("Converted garden targets to planting windows + sessions.");
  return { items, sessionSuggestions };
}

function buildAnimalTimeline(
  animalTargets,
  startISO,
  endISO,
  opts,
  rulesApplied
) {
  const items = [];
  const sessionSuggestions = [];

  for (const t of animalTargets) {
    const plan = t.plan || {};
    const firstYieldISO =
      plan.firstYieldISO || addDaysISO(startISO, opts.cadence.animals.leadDays);
    const animalName = safeStr(t.animalName || "Animals");
    const componentName = safeStr(
      t.componentName || t.componentId || "Component"
    );

    // Acquisition/breeding start milestone
    items.push({
      id: `milestone:animals:start:${safeStr(
        t.id || `${t.componentId}|${t.animalId}`
      )}`,
      dateISO: clampToRange(
        addDaysISO(startISO, opts.cadence.animals.leadDays),
        startISO,
        endISO
      ),
      domain: "animals",
      kind: "task",
      title: `${
        plan.mode === "breed" ? "Start breeding plan" : "Source animals"
      }: ${animalName}`,
      detail: `For ${componentName}: target headcount ${plan.headcount} (♀ ${
        plan.females || 0
      }, ♂ ${plan.males || 0}).`,
      priority: plan.mode === "purchase" ? 4 : 3,
      confidence: clampNum(toNum(t.confidence, 0.6), 0, 1),
      tags: uniq(["animals", `mode:${plan.mode || "unknown"}`]),
      links: t.links || {
        to: "/homesteadplanner/animal-targets",
        payload: { componentId: t.componentId, animalId: t.animalId },
      },
      explain: ["Animal target derived from AnimalTargetBuilder output."],
    });

    // First yield milestone (eggs/milk) or first harvest window (meat)
    items.push({
      id: `milestone:animals:yield:${safeStr(
        t.id || `${t.componentId}|${t.animalId}`
      )}`,
      dateISO: clampToRange(firstYieldISO, startISO, endISO),
      domain: "animals",
      kind: "milestone",
      title: `First expected yield: ${animalName}`,
      detail: `${
        t.supply?.kind || "supply"
      } expected starting ~${formatDateShort(firstYieldISO)}.`,
      priority: 3,
      confidence: clampNum(toNum(t.confidence, 0.6), 0, 1),
      tags: uniq(["animals", "yield", `kind:${t.supply?.kind || "unknown"}`]),
      links: t.links || {
        to: "/homesteadplanner/animal-targets",
        payload: { componentId: t.componentId, animalId: t.animalId },
      },
      explain: ["Yield timing estimated from lifecycle lead times."],
    });

    // Animals session
    sessionSuggestions.push(
      buildSessionFromTarget({
        domain: "animals",
        domainKey:
          plan.mode === "purchase" ? "animals_acquisition" : "animals_care",
        title: `Animals: ${
          plan.mode === "purchase" ? "source" : "plan"
        } ${animalName}`,
        startISO: clampToRange(addDaysISO(startISO, 2), startISO, endISO),
        durationMin: opts.cadence.animals.durationMin,
        steps: opts.templates.animals.map((s) => ({
          title: s,
          meta: { componentId: t.componentId, animalId: t.animalId },
        })),
        priority: plan.mode === "purchase" ? 4 : 3,
        confidence: clampNum(toNum(t.confidence, 0.6), 0, 1),
        tags: [
          "animals",
          `animal:${toLower(animalName)}`,
          `mode:${plan.mode || "unknown"}`,
        ],
        explain: [`Animal target derived for ${componentName}.`],
        links: {
          to: "/play",
          payload: {
            domainKey:
              plan.mode === "purchase" ? "animals_acquisition" : "animals_care",
            title: `Animals: ${
              plan.mode === "purchase" ? "source" : "plan"
            } ${animalName}`,
            derivedFrom: "TimelinePlanner",
            meta: {
              componentId: t.componentId,
              animalId: t.animalId,
              plan: t.plan,
              capacity: t.capacity,
            },
          },
        },
      })
    );
  }

  rulesApplied.push("Converted animal targets to tasks/milestones + sessions.");
  return { items, sessionSuggestions };
}

function buildActionsTimeline(actions, startISO, endISO, opts, rulesApplied) {
  const items = [];
  const sessionSuggestions = [];

  for (const a of actions) {
    if (!a || !a.type) continue;

    const map = opts.actionDomainMap[a.type] || {
      domain: "planning",
      domainKey: "storehouse",
    };
    const domain = map.domain;
    const domainKey = map.domainKey;

    // Determine due date
    const byISO =
      a.links?.payload?.byISO || a.links?.payload?.dateISO || a.byISO || null;
    const dueISO = clampToRange(
      byISO || addDaysISO(startISO, defaultLeadForAction(a.type, opts)),
      startISO,
      endISO
    );

    const priority = opts.priority[a.urgency] || 3;
    const confidence = clampNum(toNum(a.confidence, 0.7), 0, 1);

    items.push({
      id: `task:action:${safeStr(
        a.id || `${a.type}|${a.componentId}|${a.title}`
      )}`,
      dateISO: dueISO,
      domain,
      kind: a.type === "schedule" ? "reminder" : "task",
      title: a.title || `${a.type} action`,
      detail: a.detail || "",
      priority,
      confidence,
      tags: uniq([`action:${a.type}`, ...(a.tags || [])]),
      links: a.links || {
        to: "/homesteadplanner/targets",
        payload: { componentId: a.componentId },
      },
      explain:
        a.explain && a.explain.length
          ? a.explain.slice(0, 4)
          : [`Derived from gap action (${a.type}).`],
    });

    // Session suggestion for key action types (avoid duplicating "schedule" actions as sessions)
    if (["buy", "plant", "breed", "process"].includes(a.type)) {
      const ses = buildSessionForAction(a, domainKey, dueISO, opts);
      if (ses) sessionSuggestions.push(ses);
    }
  }

  rulesApplied.push("Converted gap actions into dated tasks + sessions.");
  return { items, sessionSuggestions };
}

/* -----------------------------------------------------------------------------
 * Sessions
 * --------------------------------------------------------------------------- */

function buildPlanningSession({
  startISO,
  opts,
  priority,
  confidence,
  title,
  explain,
}) {
  return buildSessionFromTarget({
    domain: "planning",
    domainKey: "storehouse",
    title,
    startISO: clampToRange(
      addDaysISO(startISO, 1),
      startISO,
      addDaysISO(startISO, 14)
    ),
    durationMin: opts.cadence.planning.durationMin,
    steps: opts.templates.planning.map((s) => ({ title: s })),
    priority,
    confidence,
    tags: ["planning", "feasibility"],
    explain,
    links: {
      to: "/play",
      payload: {
        domainKey: "storehouse",
        title,
        derivedFrom: "TimelinePlanner",
        meta: { focus: "feasibility" },
      },
    },
  });
}

function buildSessionForAction(action, domainKey, dueISO, opts) {
  const type = action.type;
  const domain = (opts.actionDomainMap[type] || {}).domain || "planning";

  let durationMin = 45;
  let steps = [
    { title: "Review" },
    { title: "Do work" },
    { title: "Log/update" },
  ];

  if (domain === "shopping") {
    durationMin = opts.cadence.shopping.durationMin;
    steps = opts.templates.shopping.map((s) => ({
      title: s,
      meta: { componentId: action.componentId },
    }));
  } else if (domain === "garden") {
    durationMin = opts.cadence.garden.durationMin;
    steps = opts.templates.garden.map((s) => ({
      title: s,
      meta: { componentId: action.componentId },
    }));
  } else if (domain === "animals") {
    durationMin = opts.cadence.animals.durationMin;
    steps = opts.templates.animals.map((s) => ({
      title: s,
      meta: { componentId: action.componentId },
    }));
  } else if (domain === "preservation") {
    durationMin = opts.cadence.preservation.durationMin;
    steps = opts.templates.preservation.map((s) => ({
      title: s,
      meta: { componentId: action.componentId },
    }));
  }

  const start = clampToRange(
    addDaysISO(dueISO, -1),
    addDaysISO(dueISO, -7),
    dueISO
  );

  return buildSessionFromTarget({
    domain,
    domainKey,
    title: action.title || `Session: ${type}`,
    startISO: start,
    durationMin,
    steps,
    priority: DEFAULTS.priority[action.urgency] || 3,
    confidence: clampNum(toNum(action.confidence, 0.7), 0, 1),
    tags: uniq([`action:${type}`, ...(action.tags || [])]),
    explain:
      action.explain && action.explain.length
        ? action.explain.slice(0, 3)
        : [`Session derived from ${type} action.`],
    links: {
      to: "/play",
      payload: {
        domainKey,
        title: action.title || `Session: ${type}`,
        derivedFrom: "TimelinePlanner",
        meta: {
          actionId: action.id,
          actionType: type,
          componentId: action.componentId,
          qty: action.qty,
          unit: action.unit,
          byISO: dueISO,
        },
      },
    },
  });
}

function buildSessionFromTarget({
  domain,
  domainKey,
  title,
  startISO,
  durationMin,
  steps,
  priority,
  confidence,
  tags,
  explain,
  links,
}) {
  return {
    id: `session:${domain}:${hashTiny(
      `${domain}|${domainKey}|${title}|${startISO}`
    )}`,
    domainKey,
    title,
    startISO,
    durationMin: Math.max(10, Math.round(toNum(durationMin, 45))),
    steps: Array.isArray(steps) ? steps : [],
    links: links || { to: "/play", payload: { domainKey, title } },
    priority: clampNum(toNum(priority, 3), 1, 5),
    confidence: clampNum(toNum(confidence, 0.7), 0, 1),
    tags: uniq([domain, ...(tags || [])]),
    explain: Array.isArray(explain) ? explain : [],
  };
}

/* -----------------------------------------------------------------------------
 * Ranking + Next
 * --------------------------------------------------------------------------- */

export function rankTimelineItems(items, startISO, opts) {
  const now = new Date(startISO);
  const w = opts.nextRanking;

  const scored = (items || []).map((it) => {
    const due = new Date(it.dateISO);
    const days = Number.isNaN(due.getTime())
      ? 9999
      : Math.max(0, (due.getTime() - now.getTime()) / 86400000);
    const soonScore =
      1 - clampNum(days / Math.max(1, opts.buckets.upcomingDays), 0, 1);
    const prScore = clampNum((toNum(it.priority, 3) - 1) / 4, 0, 1);
    const cfScore = clampNum(toNum(it.confidence, 0.7), 0, 1);
    const score =
      100 *
      (w.soon * soonScore + w.priority * prScore + w.confidence * cfScore);
    return { ...it, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  // drop _score
  return scored.map(({ _score, ...rest }) => rest);
}

export function rankSessions(sessions, startISO, opts) {
  const now = new Date(startISO);
  const w = opts.nextRanking;

  const scored = (sessions || []).map((s) => {
    const due = new Date(s.startISO);
    const days = Number.isNaN(due.getTime())
      ? 9999
      : Math.max(0, (due.getTime() - now.getTime()) / 86400000);
    const soonScore =
      1 - clampNum(days / Math.max(1, opts.buckets.upcomingDays), 0, 1);
    const prScore = clampNum((toNum(s.priority, 3) - 1) / 4, 0, 1);
    const cfScore = clampNum(toNum(s.confidence, 0.7), 0, 1);
    const score =
      100 *
      (w.soon * soonScore + w.priority * prScore + w.confidence * cfScore);
    return { ...s, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored.map(({ _score, ...rest }) => rest);
}

function computeNext(items, sessions, startISO, opts) {
  const now = new Date(startISO);
  const futureItems = (items || []).filter((i) => {
    const d = new Date(i.dateISO);
    return !Number.isNaN(d.getTime()) && d.getTime() >= now.getTime();
  });

  futureItems.sort(
    (a, b) => new Date(a.dateISO).getTime() - new Date(b.dateISO).getTime()
  );
  const dueISO = futureItems[0]?.dateISO || null;

  const nextItems = futureItems.slice(0, 5);

  const futureSessions = (sessions || []).filter((s) => {
    const d = new Date(s.startISO);
    return !Number.isNaN(d.getTime()) && d.getTime() >= now.getTime();
  });
  futureSessions.sort(
    (a, b) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime()
  );
  const nextSessions = futureSessions.slice(0, 3);

  return { dueISO, items: nextItems, sessions: nextSessions };
}

/* -----------------------------------------------------------------------------
 * Normalization & guards
 * --------------------------------------------------------------------------- */

function normalizeTimelineItems(items, startISO, endISO, max) {
  const out = [];
  const seen = new Set();

  for (const it of items || []) {
    if (!it || !it.id || !it.dateISO) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);

    const dateISO = clampToRange(it.dateISO, startISO, endISO);
    const endClamped = it.endISO
      ? clampToRange(it.endISO, startISO, endISO)
      : undefined;

    out.push({
      id: safeStr(it.id),
      dateISO,
      endISO: endClamped,
      domain: safeStr(it.domain || "planning"),
      kind: safeStr(it.kind || "task"),
      title: safeStr(it.title || "Untitled"),
      detail: safeStr(it.detail || ""),
      priority: clampNum(toNum(it.priority, 3), 1, 5),
      confidence: clampNum(toNum(it.confidence, 0.7), 0, 1),
      tags: uniq([...(it.tags || [])]),
      links: it.links || undefined,
      dependsOn: Array.isArray(it.dependsOn) ? it.dependsOn.slice() : undefined,
      explain: Array.isArray(it.explain) ? it.explain.slice() : undefined,
    });

    if (out.length >= max) break;
  }

  return out;
}

function normalizeSessions(sessions, startISO, endISO, max) {
  const out = [];
  const seen = new Set();

  for (const s of sessions || []) {
    if (!s || !s.id || !s.startISO) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);

    out.push({
      id: safeStr(s.id),
      domainKey: safeStr(s.domainKey || "storehouse"),
      title: safeStr(s.title || "Session"),
      startISO: clampToRange(s.startISO, startISO, endISO),
      durationMin: Math.max(10, Math.round(toNum(s.durationMin, 45))),
      steps: Array.isArray(s.steps) ? s.steps.map((st) => ({ ...st })) : [],
      links: s.links || {
        to: "/play",
        payload: { domainKey: s.domainKey, title: s.title },
      },
      priority: clampNum(toNum(s.priority, 3), 1, 5),
      confidence: clampNum(toNum(s.confidence, 0.7), 0, 1),
      tags: uniq([...(s.tags || [])]),
      explain: Array.isArray(s.explain) ? s.explain.slice() : [],
    });

    if (out.length >= max) break;
  }

  return out;
}

function defaultLeadForAction(type, opts) {
  if (type === "buy") return opts.cadence.shopping.leadDays;
  if (type === "plant") return opts.cadence.garden.leadDays;
  if (type === "breed") return opts.cadence.animals.leadDays;
  if (type === "process") return opts.cadence.preservation.leadDays;
  return opts.cadence.planning.leadDays;
}

/* -----------------------------------------------------------------------------
 * Issues collection
 * --------------------------------------------------------------------------- */

function collectIssues(blockers, risks, obj) {
  if (!obj) return;
  const b = obj.issues?.blockers || obj.blockers || [];
  const r = obj.issues?.risks || obj.risks || [];
  if (Array.isArray(b)) blockers.push(...b.map((x) => ({ ...x })));
  if (Array.isArray(r)) risks.push(...r.map((x) => ({ ...x })));
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

function rankIssues(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => toNum(b.severity, 0) - toNum(a.severity, 0));
  return arr;
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

function daysBetweenISO(aISO, bISO) {
  const a = new Date(aISO);
  const b = new Date(bISO);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function clampToRange(iso, startISO, endISO) {
  const d = new Date(iso);
  const s = new Date(startISO);
  const e = new Date(endISO);
  if (
    Number.isNaN(d.getTime()) ||
    Number.isNaN(s.getTime()) ||
    Number.isNaN(e.getTime())
  )
    return iso || startISO;
  const t = Math.max(s.getTime(), Math.min(e.getTime(), d.getTime()));
  return new Date(t).toISOString();
}

function formatDateShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
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
