// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\AnimalTargetBuilder.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead AnimalTargetBuilder
 * -----------------------------------------------------------------------------
 * Converts protein gaps (or provisioning targets) into actionable animal
 * acquisition / breeding targets:
 *  - species selection candidates (from catalog component→animal mappings)
 *  - required yield (eggs / meat / milk) normalized
 *  - headcount needed (birds/animals), batches, breeding cycles
 *  - suggested timelines (purchase now vs breed plan)
 *  - housing/feed capacity checks (coop_capacity, pasture_sqft, freezer_liters)
 *
 * Deterministic, explainable. No AI.
 *
 * -----------------------------------------------------------------------------
 * Input
 * -----------------------------------------------------------------------------
 * buildAnimalTargets({
 *   householdId,
 *   startISO,
 *   horizonDays,
 *   catalogBundle,            // CatalogLoader output (components, animals?, mappings?)
 *   targetsOutput,            // ProvisioningTargetEngine output (optional)
 *   demandPlan,               // ComponentDemandBuilder output (optional)
 *   gapActionsOutput,         // GapActionRecommender output (optional)
 *   preferencesPack,          // PreferenceResolver output (optional)
 *   equipmentProfile,         // { capacities:{ coop_capacity, pasture_sqft, freezer_liters }, tools?:{} }
 *   options
 * })
 *
 * -----------------------------------------------------------------------------
 * Catalog expectations (flexible)
 * -----------------------------------------------------------------------------
 * catalogBundle may include:
 *  - components[]: { id, name, tags[], defaults:{ unit }, animals?:{ species:[...] } }
 *  - animals[]: {
 *      id, name, tags[], kind:"poultry"|"small_ruminant"|"large_ruminant"|"fish"|"other",
 *      yields:{
 *        eggsPerWeekPerFemale?,
 *        milkLitersPerWeekPerFemale?,
 *        meatKgPerAnimal? (or meatLbPerAnimal),
 *        dressingPercent?,
 *      },
 *      lifecycle:{
 *        purchaseLeadDays?,
 *        daysToMature?,
 *        gestationDays?,
 *        clutchIntervalDays?,
 *      },
 *      feed:{ kgPerWeekPerAnimal?, notes? },
 *      housing:{ coopSlotsPerAnimal?, pastureSqftPerAnimal? }
 *    }
 *  - mappings:
 *      componentToAnimals: { [componentId]: [{ animalId, weight, notes }] }
 *
 * -----------------------------------------------------------------------------
 * Output
 * -----------------------------------------------------------------------------
 * {
 *   meta,
 *   targets: AnimalTarget[],
 *   summary: { totalHeadcount, coopSlotsNeeded, pastureSqftNeeded, feedKgPerWeek, freezerLitersNeeded },
 *   issues: { blockers[], risks[] },
 *   trace: { notes[], rulesApplied[] }
 * }
 *
 * AnimalTarget:
 * {
 *   id,
 *   componentId,
 *   componentName,
 *   animalId,
 *   animalName,
 *   requiredQty,
 *   requiredUnit,
 *   supply: {
 *     kind: "eggs"|"meat"|"milk"|"other",
 *     weeklyQty?,
 *     totalQty?,
 *     unit
 *   },
 *   plan: {
 *     mode: "purchase"|"breed"|"hybrid",
 *     headcount,
 *     females,
 *     males,
 *     cycles,
 *     leadDays,
 *     startISO,
 *     firstYieldISO,
 *   },
 *   capacity: { coopSlotsNeeded, pastureSqftNeeded, freezerLitersNeeded, feedKgPerWeek },
 *   confidence: 0..1,
 *   effort: { minutesPerWeek, difficulty: 1..5 },
 *   assumptions: string[],
 *   explain: string[],
 *   links: { to, payload }
 * }
 */

const SOURCE = "services/farmToTable/AnimalTargetBuilder";

const DEFAULTS = {
  maxTargets: 200,

  // Fallback yields if catalog missing
  yieldDefaults: {
    eggsPerWeekPerFemale: 4, // laying hen baseline
    milkLitersPerWeekPerFemale: 10, // small ruminant rough
    meatKgPerAnimal: 20, // dressed yield rough
    dressingPercent: 0.6,
  },

  // Lifecycle defaults
  lifecycleDefaults: {
    purchaseLeadDays: 14,
    daysToMature: 150, // to first egg for hens
    gestationDays: 150,
    clutchIntervalDays: 21,
  },

  // Housing defaults
  housingDefaults: {
    coopSlotsPerAnimal: 1,
    pastureSqftPerAnimal: 0,
  },

  // Feed defaults
  feedDefaults: {
    kgPerWeekPerAnimal: 1.5,
  },

  // Capacity defaults
  capacityDefaults: {
    coop_capacity: 0, // slots
    pasture_sqft: 0,
    freezer_liters: 0,
  },

  // Storage footprint for meat (liters per kg)
  storage: {
    litersPerKgMeat: 1.2,
    litersPerDozenEggs: 0.7,
    litersPerLiterMilk: 1.0,
  },

  // Effort estimates
  effort: {
    minutesPerAnimalPerWeek: 6,
    difficulty: 4,
  },

  // How we choose animal candidates when multiple exist
  animalSelection: {
    maxCandidatesPerComponent: 3,
    preferShorterLead: true,
  },

  // Action mix preferences (purchase vs breed)
  strategy: {
    defaultMode: "hybrid", // "purchase" | "breed" | "hybrid"
    // If horizon shorter than this, push purchase for first-cycle supply
    purchaseIfHorizonDaysBelow: 90,
    // If required is large, suggest breeding
    breedIfTotalUnitsAbove: 30,
  },

  // If missing mapping, allow generic target from component tags
  allowGenericFallback: true,
};

export const AnimalTargetBuilder = {
  buildAnimalTargets,
  summarize,
};

/* -----------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------- */

export function buildAnimalTargets(input = {}) {
  const opts = mergeOptions(input.options);

  const householdId = safeStr(input.householdId || "primary");
  const startISO = input.startISO || new Date().toISOString();
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : input.targetsOutput?.meta?.horizonDays || 28;

  const catalog = input.catalogBundle || {};
  const components = Array.isArray(catalog.components)
    ? catalog.components
    : [];
  const animals = Array.isArray(catalog.animals) ? catalog.animals : [];

  const componentsById = new Map(components.map((c) => [toLower(c.id), c]));
  const animalsById = new Map(animals.map((a) => [toLower(a.id), a]));

  const mappings = normalizeMappings(catalog);

  const equipment = normalizeEquipment(input.equipmentProfile, opts);

  const demandPlan = input.demandPlan || null;
  const targetsOutput = input.targetsOutput || null;
  const gapActionsOutput = input.gapActionsOutput || null;

  const rulesApplied = [];
  const notes = [];
  const blockers = [];
  const risks = [];

  const sources = collectAnimalSourceLines({
    demandPlan,
    targetsOutput,
    gapActionsOutput,
    componentsById,
  });

  if (!sources.length) {
    notes.push(
      "No animal/protein gaps/targets found to derive animal targets."
    );
    return {
      meta: {
        householdId,
        startISO,
        horizonDays,
        builtAtISO: new Date().toISOString(),
        source: SOURCE,
      },
      targets: [],
      summary: {
        totalHeadcount: 0,
        coopSlotsNeeded: 0,
        pastureSqftNeeded: 0,
        feedKgPerWeek: 0,
        freezerLitersNeeded: 0,
      },
      issues: { blockers, risks },
      trace: { notes, rulesApplied },
    };
  }

  const targets = [];

  for (const line of sources) {
    const component = componentsById.get(toLower(line.componentId)) || null;
    if (!component) continue;

    const candidates = getAnimalCandidatesForComponent(
      component,
      mappings,
      animalsById,
      opts,
      rulesApplied
    );

    if (!candidates.length) {
      if (!opts.allowGenericFallback) {
        risks.push({
          title: "No animal mapping for component",
          severity: 2,
          detail: `Component "${
            component.name || component.id
          }" has no animal mapping; cannot derive targets.`,
          domain: "animals",
          code: "animals.no_mapping",
        });
        continue;
      }
      const generic = buildGenericAnimalTargetFromComponent(
        line,
        component,
        opts,
        startISO,
        horizonDays,
        equipment
      );
      if (generic) targets.push(generic);
      continue;
    }

    const selected = rankAnimalCandidates(candidates, opts).slice(
      0,
      opts.animalSelection.maxCandidatesPerComponent
    );

    for (const cand of selected) {
      const animal = cand.animal;
      const at = buildTargetForAnimal({
        line,
        component,
        animal,
        weight: cand.weight,
        opts,
        startISO,
        horizonDays,
        equipment,
        rulesApplied,
      });
      if (at) targets.push(at);
      if (targets.length >= opts.maxTargets) break;
    }
    if (targets.length >= opts.maxTargets) break;
  }

  // Capacity aggregation + checks
  const totalHeadcount = sum(targets.map((t) => toNum(t.plan?.headcount, 0)));
  const coopSlotsNeeded = sum(
    targets.map((t) => toNum(t.capacity?.coopSlotsNeeded, 0))
  );
  const pastureSqftNeeded = sum(
    targets.map((t) => toNum(t.capacity?.pastureSqftNeeded, 0))
  );
  const feedKgPerWeek = sum(
    targets.map((t) => toNum(t.capacity?.feedKgPerWeek, 0))
  );
  const freezerLitersNeeded = sum(
    targets.map((t) => toNum(t.capacity?.freezerLitersNeeded, 0))
  );

  const coopCap = toNum(equipment.capacities.coop_capacity, 0);
  const pastureCap = toNum(equipment.capacities.pasture_sqft, 0);
  const freezerCap = toNum(equipment.capacities.freezer_liters, 0);

  if (coopCap > 0 && coopSlotsNeeded > coopCap * 1.05) {
    blockers.push({
      title: "Animal housing capacity insufficient",
      severity: 5,
      detail: `Need ~${Math.round(
        coopSlotsNeeded
      )} coop slots but capacity is ${Math.round(coopCap)}.`,
      domain: "animals",
      code: "animals.coop_capacity_blocked",
    });
  } else if (coopCap > 0 && coopSlotsNeeded > coopCap * 0.9) {
    risks.push({
      title: "Animal housing capacity tight",
      severity: 3,
      detail: `Need ~${Math.round(
        coopSlotsNeeded
      )} coop slots (cap ${Math.round(coopCap)}).`,
      domain: "animals",
      code: "animals.coop_capacity_tight",
    });
  } else if (coopCap <= 0) {
    risks.push({
      title: "Coop capacity not set",
      severity: 2,
      detail:
        "Set coop_capacity in equipment profile to validate animal targets.",
      domain: "animals",
      code: "animals.coop_capacity_missing",
    });
  }

  if (pastureSqftNeeded > 0) {
    if (pastureCap > 0 && pastureSqftNeeded > pastureCap * 1.05) {
      blockers.push({
        title: "Pasture space insufficient",
        severity: 5,
        detail: `Need ~${Math.round(
          pastureSqftNeeded
        )} sqft pasture but capacity is ${Math.round(pastureCap)}.`,
        domain: "animals",
        code: "animals.pasture_blocked",
      });
    } else if (pastureCap > 0 && pastureSqftNeeded > pastureCap * 0.9) {
      risks.push({
        title: "Pasture space tight",
        severity: 3,
        detail: `Need ~${Math.round(
          pastureSqftNeeded
        )} sqft pasture (cap ${Math.round(pastureCap)}).`,
        domain: "animals",
        code: "animals.pasture_tight",
      });
    } else if (pastureCap <= 0) {
      risks.push({
        title: "Pasture capacity not set",
        severity: 2,
        detail:
          "Set pasture_sqft in equipment profile if raising grazing animals.",
        domain: "animals",
        code: "animals.pasture_missing",
      });
    }
  }

  if (freezerLitersNeeded > 0) {
    if (freezerCap > 0 && freezerLitersNeeded > freezerCap * 1.05) {
      blockers.push({
        title: "Freezer capacity insufficient for planned meat/milk",
        severity: 5,
        detail: `Need ~${Math.round(
          freezerLitersNeeded
        )} L freezer space but capacity is ${Math.round(freezerCap)} L.`,
        domain: "storehouse",
        code: "animals.freezer_blocked",
      });
    } else if (freezerCap > 0 && freezerLitersNeeded > freezerCap * 0.9) {
      risks.push({
        title: "Freezer capacity tight for planned meat/milk",
        severity: 3,
        detail: `Need ~${Math.round(
          freezerLitersNeeded
        )} L freezer space (cap ${Math.round(freezerCap)} L).`,
        domain: "storehouse",
        code: "animals.freezer_tight",
      });
    } else if (freezerCap <= 0) {
      risks.push({
        title: "Freezer capacity not set",
        severity: 2,
        detail:
          "Set freezer_liters in equipment profile to validate meat/milk storage impact.",
        domain: "storehouse",
        code: "animals.freezer_missing",
      });
    }
  }

  return {
    meta: {
      householdId,
      startISO,
      horizonDays,
      builtAtISO: new Date().toISOString(),
      source: SOURCE,
    },
    targets: targets.sort((a, b) => (b.confidence || 0) - (a.confidence || 0)),
    summary: {
      totalHeadcount: Math.round(totalHeadcount),
      coopSlotsNeeded: round1(coopSlotsNeeded),
      pastureSqftNeeded: round1(pastureSqftNeeded),
      feedKgPerWeek: round1(feedKgPerWeek),
      freezerLitersNeeded: round1(freezerLitersNeeded),
      coopCapacity: coopCap,
      pastureCapacity: pastureCap,
      freezerCapacity: freezerCap,
    },
    issues: { blockers: rankIssues(blockers), risks: rankIssues(risks) },
    trace: { notes, rulesApplied: uniq(rulesApplied) },
  };
}

export function summarize(output) {
  const o = output || {};
  const t = Array.isArray(o.targets) ? o.targets : [];
  return [
    `Animal targets: ${t.length}`,
    `Headcount: ${o.summary?.totalHeadcount || 0} • Coop slots: ${
      o.summary?.coopSlotsNeeded || 0
    }/${o.summary?.coopCapacity || 0}`,
    `Feed kg/week: ${o.summary?.feedKgPerWeek || 0} • Freezer L: ${
      o.summary?.freezerLitersNeeded || 0
    }/${o.summary?.freezerCapacity || 0}`,
  ];
}

/* -----------------------------------------------------------------------------
 * Source lines
 * --------------------------------------------------------------------------- */

function collectAnimalSourceLines({
  demandPlan,
  targetsOutput,
  gapActionsOutput,
  componentsById,
}) {
  const out = [];

  // demandPlan gaps
  const gaps = Array.isArray(demandPlan?.gaps) ? demandPlan.gaps : [];
  for (const g of gaps) {
    const gapQty = Math.max(0, toNum(g.gapQty, 0));
    if (gapQty <= 0) continue;

    const component = componentsById.get(toLower(g.componentId));
    if (!component) continue;
    if (!isAnimalEligibleComponent(component)) continue;

    out.push({
      source: "demandPlan.gaps",
      componentId: g.componentId,
      qty: gapQty,
      unit: normalizeUnit(g.unit || component?.defaults?.unit || "each"),
      requiredQty: toNum(g.requiredQty, 0),
      byISO: g.byISO || null,
    });
  }

  // breed actions
  const actions = Array.isArray(gapActionsOutput?.actions)
    ? gapActionsOutput.actions
    : [];
  for (const a of actions) {
    if (a.type !== "breed") continue;
    const component = componentsById.get(toLower(a.componentId));
    if (!component) continue;
    if (!isAnimalEligibleComponent(component)) continue;

    out.push({
      source: "gapActions.breed",
      componentId: a.componentId,
      qty: Math.max(0, toNum(a.qty, 0)),
      unit: normalizeUnit(a.unit || component?.defaults?.unit || "each"),
      requiredQty: null,
      byISO: a.links?.payload?.byISO || null,
    });
  }

  // provisioning targets fallback
  const prov = Array.isArray(targetsOutput?.provisioning)
    ? targetsOutput.provisioning
    : [];
  for (const p of prov) {
    const component = componentsById.get(toLower(p.componentId));
    if (!component) continue;
    if (!isAnimalEligibleComponent(component)) continue;

    out.push({
      source: "targetsOutput.provisioning",
      componentId: p.componentId,
      qty: Math.max(0, toNum(p.qty, 0)),
      unit: normalizeUnit(p.unit || component?.defaults?.unit || "each"),
      requiredQty: null,
      byISO: p.byISO || null,
    });
  }

  // de-dupe by component+unit
  const map = new Map();
  for (const l of out) {
    const k = `${toLower(l.componentId)}|${normalizeUnit(l.unit)}`;
    const prev = map.get(k);
    if (!prev) map.set(k, { ...l });
    else {
      prev.qty += toNum(l.qty, 0);
      if (!prev.byISO && l.byISO) prev.byISO = l.byISO;
    }
  }

  return Array.from(map.values()).filter((x) => x.qty > 0);
}

function isAnimalEligibleComponent(component) {
  const tags = normalizeStringArray(component?.tags).map(toLower);
  if (component?.animals?.enabled === true) return true;
  if (
    tags.some((t) =>
      ["meat", "poultry", "fish", "eggs", "dairy", "milk", "cheese"].includes(t)
    )
  )
    return true;
  return false;
}

/* -----------------------------------------------------------------------------
 * Candidates
 * --------------------------------------------------------------------------- */

function normalizeMappings(catalog) {
  const m =
    catalog?.mappings && typeof catalog.mappings === "object"
      ? catalog.mappings
      : {};
  const componentToAnimals =
    m.componentToAnimals && typeof m.componentToAnimals === "object"
      ? m.componentToAnimals
      : {};
  return { componentToAnimals };
}

function getAnimalCandidatesForComponent(
  component,
  mappings,
  animalsById,
  opts,
  rulesApplied
) {
  const cid = toLower(component.id);
  const direct = Array.isArray(component?.animals?.species)
    ? component.animals.species
    : null;
  const mapped =
    mappings.componentToAnimals[cid] ||
    mappings.componentToAnimals[component.id] ||
    null;

  const list = [];

  const pushCandidate = (animalId, weight, notes) => {
    const animal = animalsById.get(toLower(animalId));
    if (!animal) return;
    list.push({
      animal,
      weight: toNum(weight, 1),
      notes: safeStr(notes || ""),
    });
  };

  if (Array.isArray(direct) && direct.length) {
    for (const a of direct) {
      if (typeof a === "string")
        pushCandidate(a, 1, "component.animals.species");
      else if (a && typeof a === "object")
        pushCandidate(
          a.animalId || a.id,
          a.weight || 1,
          a.notes || "component.animals.species"
        );
    }
    rulesApplied.push("Used component.animals.species mappings.");
  }

  if (Array.isArray(mapped) && mapped.length) {
    for (const a of mapped) {
      if (typeof a === "string")
        pushCandidate(a, 1, "mappings.componentToAnimals");
      else if (a && typeof a === "object")
        pushCandidate(
          a.animalId || a.id,
          a.weight || 1,
          a.notes || "mappings.componentToAnimals"
        );
    }
    rulesApplied.push("Used catalog.mappings.componentToAnimals mappings.");
  }

  // Tag overlap fallback
  if (!list.length) {
    const componentTags = new Set(
      normalizeStringArray(component?.tags).map(toLower)
    );
    for (const [_, animal] of animalsById.entries()) {
      const animalTags = normalizeStringArray(animal?.tags).map(toLower);
      const overlap = animalTags.filter((t) => componentTags.has(t)).length;
      if (overlap > 0)
        list.push({ animal, weight: overlap, notes: "tag overlap fallback" });
    }
    if (list.length)
      rulesApplied.push("Used tag-overlap fallback animal matching.");
  }

  // de-dupe by id (keep best weight)
  const map = new Map();
  for (const c of list) {
    const id = toLower(c.animal.id);
    const prev = map.get(id);
    if (!prev || prev.weight < c.weight) map.set(id, c);
  }
  return Array.from(map.values());
}

function rankAnimalCandidates(candidates, opts) {
  const scored = candidates.map((c) => {
    const lead = toNum(
      c.animal?.lifecycle?.purchaseLeadDays,
      DEFAULTS.lifecycleDefaults.purchaseLeadDays
    );
    const score =
      c.weight * 10 +
      (opts.animalSelection.preferShorterLead
        ? clampNum(30 / Math.max(7, lead), 0, 1) * 10
        : 0);
    return { ...c, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

/* -----------------------------------------------------------------------------
 * Build target for animal
 * --------------------------------------------------------------------------- */

function buildTargetForAnimal({
  line,
  component,
  animal,
  weight,
  opts,
  startISO,
  horizonDays,
  equipment,
  rulesApplied,
}) {
  const componentId = safeStr(component.id);
  const componentName = safeStr(component.name || componentId);
  const animalId = safeStr(animal.id);
  const animalName = safeStr(animal.name || animalId);

  const requiredQty = Math.max(0, toNum(line.qty, 0));
  const requiredUnit = normalizeUnit(
    line.unit || component?.defaults?.unit || "each"
  );

  // Determine supply kind based on component tags
  const supplyKind = inferSupplyKind(component, animal);

  const yields = normalizeYields(animal, opts);
  const lifecycle = normalizeLifecycle(animal, opts);
  const housing = normalizeHousing(animal, opts);
  const feed = normalizeFeed(animal, opts);

  const assumptions = [];
  const explain = [];
  explain.push(`Derived from ${line.source} for component "${componentName}".`);
  explain.push(`Selected species "${animalName}" (weight ${fmtQty(weight)}).`);

  // Convert requirement into supply units
  const requiredSupply = convertRequirementToSupply(
    requiredQty,
    requiredUnit,
    supplyKind
  );

  // Determine mode (purchase/breed/hybrid)
  const mode = chooseStrategyMode(requiredSupply.totalUnits, horizonDays, opts);

  const plan = buildPlanForSupply({
    supplyKind,
    requiredSupply,
    yields,
    lifecycle,
    mode,
    startISO,
    horizonDays,
  });

  // Capacity impacts
  const cap = computeCapacity(plan, supplyKind, yields, housing, feed, opts);

  // Confidence
  let confidence = 0.6;
  if (animal?.yields) confidence += 0.15;
  if (animal?.housing) confidence += 0.05;
  if (animal?.feed) confidence += 0.05;
  confidence = clampNum(confidence, 0, 1);

  // Effort
  const minutesPerWeek = Math.round(
    plan.headcount * opts.effort.minutesPerAnimalPerWeek
  );
  const effort = {
    minutesPerWeek: clampNum(minutesPerWeek, 10, 2400),
    difficulty: opts.effort.difficulty,
  };

  // Storage impact if meat/milk/eggs
  const freezerLitersNeeded = cap.freezerLitersNeeded;
  const freezerCap = toNum(equipment.capacities.freezer_liters, 0);
  if (
    freezerLitersNeeded > 0 &&
    freezerCap > 0 &&
    freezerLitersNeeded > freezerCap * 1.05
  ) {
    explain.push(
      "Warning: freezer capacity may be insufficient for planned storage impact."
    );
  }

  assumptions.push(...plan.assumptions);
  assumptions.push(...cap.assumptions);

  const id = `animal:${componentId}:${animalId}:${hashTiny(
    `${componentId}|${animalId}|${requiredQty}|${requiredUnit}`
  )}`;

  rulesApplied.push(
    "Built animal targets from protein gaps using species yields + lifecycle."
  );

  return {
    id,
    componentId,
    componentName,
    animalId,
    animalName,
    requiredQty,
    requiredUnit,
    supply: {
      kind: supplyKind,
      weeklyQty: plan.weeklySupplyQty,
      totalQty: plan.totalSupplyQty,
      unit: plan.supplyUnit,
    },
    plan,
    capacity: cap,
    confidence,
    effort,
    assumptions,
    explain,
    links: {
      to: "/homesteadplanner/animal-targets",
      payload: {
        componentId,
        animalId,
        requiredQty,
        requiredUnit,
        supplyKind,
        plan,
        capacity: cap,
        derivedFrom: line.source,
      },
    },
  };
}

function buildGenericAnimalTargetFromComponent(
  line,
  component,
  opts,
  startISO,
  horizonDays,
  equipment
) {
  const componentId = safeStr(component.id);
  const componentName = safeStr(component.name || componentId);

  const requiredQty = Math.max(0, toNum(line.qty, 0));
  const requiredUnit = normalizeUnit(
    line.unit || component?.defaults?.unit || "each"
  );

  const tags = normalizeStringArray(component?.tags).map(toLower);

  // Pick a generic species based on tags
  let animalName = "livestock";
  let supplyKind = "meat";
  if (tags.includes("eggs")) {
    animalName = "laying hens";
    supplyKind = "eggs";
  } else if (tags.includes("dairy") || tags.includes("milk")) {
    animalName = "dairy goats";
    supplyKind = "milk";
  } else if (tags.includes("fish")) {
    animalName = "fish";
    supplyKind = "meat";
  }

  const requiredSupply = convertRequirementToSupply(
    requiredQty,
    requiredUnit,
    supplyKind
  );
  const yields = normalizeYields(null, opts);
  const lifecycle = normalizeLifecycle(null, opts);
  const housing = normalizeHousing(null, opts);
  const feed = normalizeFeed(null, opts);

  const mode = chooseStrategyMode(requiredSupply.totalUnits, horizonDays, opts);
  const plan = buildPlanForSupply({
    supplyKind,
    requiredSupply,
    yields,
    lifecycle,
    mode,
    startISO,
    horizonDays,
  });
  const cap = computeCapacity(plan, supplyKind, yields, housing, feed, opts);

  const id = `animal:${componentId}:generic:${hashTiny(
    `${componentId}|generic|${requiredQty}|${requiredUnit}`
  )}`;

  return {
    id,
    componentId,
    componentName,
    animalId: null,
    animalName,
    requiredQty,
    requiredUnit,
    supply: {
      kind: supplyKind,
      weeklyQty: plan.weeklySupplyQty,
      totalQty: plan.totalSupplyQty,
      unit: plan.supplyUnit,
    },
    plan,
    capacity: cap,
    confidence: 0.35,
    effort: {
      minutesPerWeek: clampNum(
        Math.round(plan.headcount * opts.effort.minutesPerAnimalPerWeek),
        10,
        2400
      ),
      difficulty: opts.effort.difficulty,
    },
    assumptions: ["No species mapping; used generic animal defaults."],
    explain: [
      `Derived from ${line.source}. No animal mapping found for "${componentName}".`,
      "Used default yields + lifecycle assumptions.",
    ],
    links: {
      to: "/homesteadplanner/animal-targets",
      payload: {
        componentId,
        animalId: null,
        requiredQty,
        requiredUnit,
        supplyKind,
        plan,
        capacity: cap,
        derivedFrom: line.source,
      },
    },
  };
}

/* -----------------------------------------------------------------------------
 * Strategy + supply conversions
 * --------------------------------------------------------------------------- */

function inferSupplyKind(component, animal) {
  const cTags = normalizeStringArray(component?.tags).map(toLower);
  const aTags = normalizeStringArray(animal?.tags).map(toLower);

  if (cTags.includes("eggs") || aTags.includes("eggs")) return "eggs";
  if (
    cTags.includes("dairy") ||
    cTags.includes("milk") ||
    aTags.includes("milk") ||
    aTags.includes("dairy")
  )
    return "milk";
  if (cTags.includes("fish") || aTags.includes("fish")) return "meat";
  if (
    cTags.includes("meat") ||
    cTags.includes("poultry") ||
    aTags.includes("meat") ||
    aTags.includes("poultry")
  )
    return "meat";
  return "meat";
}

function convertRequirementToSupply(qty, unit, kind) {
  // Keep it simple: treat "each" as 1 unit.
  // For "serving": treat as 1 unit.
  // For "lb/kg" with meat: convert to kg meat units.
  const q = toNum(qty, 0);
  const u = normalizeUnit(unit);

  if (kind === "meat") {
    if (u === "kg") return { totalUnits: q, unit: "kg" };
    if (u === "lb") return { totalUnits: q * 0.453592, unit: "kg" };
    return { totalUnits: q, unit: "unit" };
  }

  if (kind === "eggs") {
    // if unit is dozen
    if (u === "dozen") return { totalUnits: q * 12, unit: "egg" };
    if (u === "egg" || u === "each") return { totalUnits: q, unit: "egg" };
    return { totalUnits: q, unit: "egg" };
  }

  if (kind === "milk") {
    if (u === "l" || u === "liter" || u === "liters")
      return { totalUnits: q, unit: "l" };
    if (u === "gal") return { totalUnits: q * 3.78541, unit: "l" };
    if (u === "qt") return { totalUnits: q * 0.946353, unit: "l" };
    return { totalUnits: q, unit: "l" };
  }

  return { totalUnits: q, unit: "unit" };
}

function chooseStrategyMode(totalUnits, horizonDays, opts) {
  const s = opts.strategy;
  if (horizonDays < s.purchaseIfHorizonDaysBelow) return "purchase";
  if (totalUnits >= s.breedIfTotalUnitsAbove) return "breed";
  return s.defaultMode || "hybrid";
}

function buildPlanForSupply({
  supplyKind,
  requiredSupply,
  yields,
  lifecycle,
  mode,
  startISO,
  horizonDays,
}) {
  const assumptions = [];
  const leadPurchase = toNum(
    lifecycle.purchaseLeadDays,
    DEFAULTS.lifecycleDefaults.purchaseLeadDays
  );
  const daysToMature = toNum(
    lifecycle.daysToMature,
    DEFAULTS.lifecycleDefaults.daysToMature
  );

  let headcount = 0;
  let females = 0;
  let males = 0;
  let cycles = 1;

  let weeklySupplyQty = 0;
  let totalSupplyQty = requiredSupply.totalUnits;
  let supplyUnit = requiredSupply.unit;

  let firstYieldISO = addDaysISO(startISO, leadPurchase);

  if (supplyKind === "eggs") {
    const eggsPerWeek = Math.max(
      0.1,
      toNum(
        yields.eggsPerWeekPerFemale,
        DEFAULTS.yieldDefaults.eggsPerWeekPerFemale
      )
    );
    // Need weekly eggs: assume requirement is total over horizon -> convert to weekly
    const weeks = Math.max(1, horizonDays / 7);
    const needPerWeek = requiredSupply.totalUnits / weeks;

    if (mode === "breed") {
      // breeding implies delay to maturity
      firstYieldISO = addDaysISO(startISO, leadPurchase + daysToMature);
      assumptions.push(
        "Egg supply assumes time to maturity for pullets in breed mode."
      );
    } else {
      firstYieldISO = addDaysISO(startISO, leadPurchase);
    }

    females = Math.ceil(needPerWeek / eggsPerWeek);
    males = 0;
    headcount = females + males;

    weeklySupplyQty = females * eggsPerWeek;
    supplyUnit = "egg";
  } else if (supplyKind === "milk") {
    const milkPerWeek = Math.max(
      0.1,
      toNum(
        yields.milkLitersPerWeekPerFemale,
        DEFAULTS.yieldDefaults.milkLitersPerWeekPerFemale
      )
    );
    const weeks = Math.max(1, horizonDays / 7);
    const needPerWeek = requiredSupply.totalUnits / weeks;

    if (mode === "breed") {
      // breeding delay (gestation + maturity rough)
      const gest = toNum(
        lifecycle.gestationDays,
        DEFAULTS.lifecycleDefaults.gestationDays
      );
      firstYieldISO = addDaysISO(startISO, leadPurchase + gest);
      assumptions.push("Milk supply assumes gestation delay in breed mode.");
    } else {
      firstYieldISO = addDaysISO(startISO, leadPurchase);
    }

    females = Math.ceil(needPerWeek / milkPerWeek);
    males = mode === "breed" && females > 0 ? 1 : 0; // simple
    headcount = females + males;

    weeklySupplyQty = females * milkPerWeek;
    supplyUnit = "l";
  } else {
    // meat
    const meatKg = Math.max(
      0.1,
      toNum(yields.meatKgPerAnimal, DEFAULTS.yieldDefaults.meatKgPerAnimal)
    );
    const needKg =
      requiredSupply.unit === "kg"
        ? requiredSupply.totalUnits
        : requiredSupply.totalUnits; // already normalized
    // For meat, treat requirement as total; compute number of animals needed
    headcount = Math.ceil(needKg / meatKg);

    // In breed mode, assume longer lead before first harvest
    if (mode === "breed") {
      const gest = toNum(
        lifecycle.gestationDays,
        DEFAULTS.lifecycleDefaults.gestationDays
      );
      const grow = toNum(lifecycle.daysToMature, 180);
      firstYieldISO = addDaysISO(startISO, leadPurchase + gest + grow);
      assumptions.push(
        "Meat supply assumes gestation + grow-out delay in breed mode."
      );
    } else {
      firstYieldISO = addDaysISO(
        startISO,
        leadPurchase + toNum(lifecycle.daysToMature, 60)
      );
    }

    females = mode === "breed" ? Math.max(1, Math.ceil(headcount / 4)) : 0;
    males = mode === "breed" ? 1 : 0;

    weeklySupplyQty = 0; // meat is batch/harvest
    supplyUnit = "kg";
  }

  // Hybrid mode: purchase now to cover first cycle, breed to sustain
  if (mode === "hybrid") {
    // Keep purchase for now, mark cycles=2 to indicate sustainment
    cycles = 2;
    assumptions.push(
      "Hybrid: purchase for near-term supply; breed/maintain to sustain future cycles."
    );
  }

  return {
    mode,
    headcount,
    females,
    males,
    cycles,
    leadDays: mode === "breed" ? leadPurchase + daysToMature : leadPurchase,
    startISO,
    firstYieldISO,
    weeklySupplyQty: round1(weeklySupplyQty),
    totalSupplyQty: round1(totalSupplyQty),
    supplyUnit,
    assumptions,
  };
}

/* -----------------------------------------------------------------------------
 * Capacity impacts
 * --------------------------------------------------------------------------- */

function computeCapacity(plan, supplyKind, yields, housing, feed, opts) {
  const assumptions = [];
  const headcount = Math.max(0, toNum(plan.headcount, 0));

  const coopSlotsNeeded =
    headcount *
    toNum(
      housing.coopSlotsPerAnimal,
      DEFAULTS.housingDefaults.coopSlotsPerAnimal
    );
  const pastureSqftNeeded =
    headcount *
    toNum(
      housing.pastureSqftPerAnimal,
      DEFAULTS.housingDefaults.pastureSqftPerAnimal
    );
  const feedKgPerWeek =
    headcount *
    toNum(feed.kgPerWeekPerAnimal, DEFAULTS.feedDefaults.kgPerWeekPerAnimal);

  // Freezer liters impact depends on kind and total supply
  let freezerLitersNeeded = 0;

  if (supplyKind === "meat") {
    const kg = plan.totalSupplyQty; // kg
    freezerLitersNeeded = kg * opts.storage.litersPerKgMeat;
    assumptions.push(
      "Freezer liters estimated from kg meat × litersPerKgMeat."
    );
  } else if (supplyKind === "eggs") {
    const eggs = plan.totalSupplyQty; // eggs
    const dozens = eggs / 12;
    freezerLitersNeeded = dozens * opts.storage.litersPerDozenEggs * 0.2; // most eggs not frozen; small impact
    assumptions.push(
      "Egg storage impact is minimal; estimated small fraction as frozen."
    );
  } else if (supplyKind === "milk") {
    const liters = plan.totalSupplyQty; // liters
    freezerLitersNeeded = liters * opts.storage.litersPerLiterMilk * 0.3; // some frozen/processed
    assumptions.push(
      "Milk storage impact estimated as partial frozen/processed volume."
    );
  }

  return {
    coopSlotsNeeded: round1(coopSlotsNeeded),
    pastureSqftNeeded: round1(pastureSqftNeeded),
    feedKgPerWeek: round1(feedKgPerWeek),
    freezerLitersNeeded: round1(freezerLitersNeeded),
    assumptions,
  };
}

/* -----------------------------------------------------------------------------
 * Normalizers
 * --------------------------------------------------------------------------- */

function normalizeYields(animal, opts) {
  const y =
    animal?.yields && typeof animal.yields === "object" ? animal.yields : {};
  const meatLb = toNum(y.meatLbPerAnimal, toNum(y.meat_lb_per_animal, null));
  const meatKg = Number.isFinite(meatLb)
    ? meatLb * 0.453592
    : toNum(
        y.meatKgPerAnimal,
        toNum(y.meat_kg_per_animal, opts.yieldDefaults.meatKgPerAnimal)
      );
  return {
    eggsPerWeekPerFemale: toNum(
      y.eggsPerWeekPerFemale,
      toNum(y.eggs_per_week_per_female, opts.yieldDefaults.eggsPerWeekPerFemale)
    ),
    milkLitersPerWeekPerFemale: toNum(
      y.milkLitersPerWeekPerFemale,
      toNum(
        y.milk_liters_per_week_per_female,
        opts.yieldDefaults.milkLitersPerWeekPerFemale
      )
    ),
    meatKgPerAnimal: toNum(meatKg, opts.yieldDefaults.meatKgPerAnimal),
    dressingPercent: clampNum(
      toNum(
        y.dressingPercent,
        toNum(y.dressing_percent, opts.yieldDefaults.dressingPercent)
      ),
      0.2,
      0.9
    ),
  };
}

function normalizeLifecycle(animal, opts) {
  const l =
    animal?.lifecycle && typeof animal.lifecycle === "object"
      ? animal.lifecycle
      : {};
  return {
    purchaseLeadDays: toNum(
      l.purchaseLeadDays,
      toNum(l.purchase_lead_days, opts.lifecycleDefaults.purchaseLeadDays)
    ),
    daysToMature: toNum(
      l.daysToMature,
      toNum(l.days_to_mature, opts.lifecycleDefaults.daysToMature)
    ),
    gestationDays: toNum(
      l.gestationDays,
      toNum(l.gestation_days, opts.lifecycleDefaults.gestationDays)
    ),
    clutchIntervalDays: toNum(
      l.clutchIntervalDays,
      toNum(l.clutch_interval_days, opts.lifecycleDefaults.clutchIntervalDays)
    ),
  };
}

function normalizeHousing(animal, opts) {
  const h =
    animal?.housing && typeof animal.housing === "object" ? animal.housing : {};
  return {
    coopSlotsPerAnimal: toNum(
      h.coopSlotsPerAnimal,
      toNum(h.coop_slots_per_animal, opts.housingDefaults.coopSlotsPerAnimal)
    ),
    pastureSqftPerAnimal: toNum(
      h.pastureSqftPerAnimal,
      toNum(
        h.pasture_sqft_per_animal,
        opts.housingDefaults.pastureSqftPerAnimal
      )
    ),
  };
}

function normalizeFeed(animal, opts) {
  const f = animal?.feed && typeof animal.feed === "object" ? animal.feed : {};
  return {
    kgPerWeekPerAnimal: toNum(
      f.kgPerWeekPerAnimal,
      toNum(f.kg_per_week_per_animal, opts.feedDefaults.kgPerWeekPerAnimal)
    ),
  };
}

function normalizeEquipment(raw, opts) {
  const capsIn =
    raw?.capacities && typeof raw.capacities === "object" ? raw.capacities : {};
  const capacities = { ...opts.capacityDefaults };
  for (const k of Object.keys(capacities))
    capacities[k] = toNum(capsIn[k], capacities[k]);
  const tools =
    raw?.tools && typeof raw.tools === "object" ? { ...raw.tools } : {};
  return { capacities, tools };
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

function sum(nums) {
  let s = 0;
  for (const n of nums || []) s += toNum(n, 0);
  return s;
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
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

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => safeStr(x)).filter(Boolean);
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
