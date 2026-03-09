// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\GardenTargetBuilder.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead GardenTargetBuilder
 * -----------------------------------------------------------------------------
 * Converts provisioning gaps (or provisioning targets) into actionable garden
 * planting targets:
 *  - crop selection candidates (from catalog component→crop mappings)
 *  - required harvest qty (normalized)
 *  - planting qty (plants / rows / sqft / seed packets)
 *  - suggested succession schedule (start dates, intervals)
 *  - feasibility notes (season window, bed space, lead time)
 *
 * Deterministic, explainable. No AI.
 *
 * -----------------------------------------------------------------------------
 * Input
 * -----------------------------------------------------------------------------
 * buildGardenTargets({
 *   householdId,
 *   startISO,
 *   horizonDays,
 *   catalogBundle,            // CatalogLoader output (components, crops?, mappings?)
 *   targetsOutput,            // ProvisioningTargetEngine output (optional)
 *   demandPlan,               // ComponentDemandBuilder output (optional)
 *   gapActionsOutput,         // GapActionRecommender output (optional)
 *   cuisineSelection,         // CuisineResolver output (optional)
 *   preferencesPack,          // PreferenceResolver output (optional)
 *   equipmentProfile,         // { capacities: { garden_sqft }, beds?: [{id, sqft}] }
 *   climateProfile,           // optional: { zone?, lastFrostISO?, firstFrostISO?, hemisphere? }
 *   options
 * })
 *
 * -----------------------------------------------------------------------------
 * Catalog expectations (flexible)
 * -----------------------------------------------------------------------------
 * catalogBundle may include:
 *  - components[]: { id, name, tags[], defaults: { unit, ... }, garden?: { crops:[...] } }
 *  - crops[]: { id, name, tags[], yield: { perPlant?, perSqft?, perRowFt? }, spacing: {...}, daysToMaturity, harvestWindowDays, seed: {...}, seasons: {...} }
 *  - mappings:
 *      componentToCrops: { [componentId]: [{ cropId, weight, notes }] }
 *
 * If crops/mappings are missing, we degrade gracefully with placeholder math.
 *
 * -----------------------------------------------------------------------------
 * Output
 * -----------------------------------------------------------------------------
 * {
 *   meta,
 *   targets: GardenTarget[],
 *   summary: { totalSqft, totalPlants, totalPackets, byBed? },
 *   issues: { blockers[], risks[] },
 *   trace: { notes[], rulesApplied[] }
 * }
 *
 * GardenTarget:
 * {
 *   id,
 *   componentId,
 *   componentName,
 *   cropId,
 *   cropName,
 *   requiredQty,
 *   requiredUnit,
 *   harvestQty,
 *   harvestUnit,
 *   planting: {
 *     plants, sqft, rowFt, packets,
 *     succession: { startsISO[], intervalDays, cycles }
 *   },
 *   timing: {
 *     idealStartISO,
 *     latestStartISO,
 *     daysToMaturity,
 *     harvestWindowDays,
 *     withinSeason: boolean,
 *   },
 *   confidence: 0..1,
 *   effort: { minutes, difficulty: 1..5 },
 *   assumptions: string[],
 *   explain: string[],
 *   links: { to, payload }
 * }
 */

const SOURCE = "services/farmToTable/GardenTargetBuilder";

const DEFAULTS = {
  // Max targets
  maxTargets: 200,

  // Default yield assumptions (fallback)
  yieldDefaults: {
    perPlant: 0.5, // "units" per plant per harvest window (arbitrary)
    perSqft: 0.25, // "units" per sqft per harvest window
    perRowFt: 0.15, // "units" per row foot
  },

  // Default spacing assumptions (fallback)
  spacingDefaults: {
    sqftPerPlant: 1.0, // 12"x12"
    rowFtPerPlant: 0.5,
    seedsPerPacket: 25,
    germinationRate: 0.75,
  },

  // Succession defaults
  succession: {
    enabled: true,
    defaultCycles: 2,
    minIntervalDays: 14,
  },

  // Capacity defaults
  capacityDefaults: {
    garden_sqft: 0,
  },

  // Effort estimates
  effort: {
    minutesPerSqft: 2,
    minutesPerPlant: 0.4,
    difficulty: 3,
  },

  // If required unit is "serving", assume servings to "units" for garden of 1:1
  servingToUnitRatio: 1.0,

  // How we choose crops when multiple candidates exist
  cropSelection: {
    maxCandidatesPerComponent: 3,
    preferInSeason: true,
    preferShorterMaturity: true,
  },

  // Season window assumptions if climateProfile missing
  seasonFallback: {
    // allow planting anytime, but mark withinSeason unknown
    assumeWithinSeason: true,
  },
};

export const GardenTargetBuilder = {
  buildGardenTargets,
  summarize,
};

/* -----------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------- */

export function buildGardenTargets(input = {}) {
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
  const crops = Array.isArray(catalog.crops) ? catalog.crops : [];

  const componentsById = new Map(components.map((c) => [toLower(c.id), c]));
  const cropsById = new Map(crops.map((c) => [toLower(c.id), c]));

  const mappings = normalizeMappings(catalog);

  const equipment = normalizeEquipment(input.equipmentProfile, opts);
  const climate = normalizeClimate(input.climateProfile, startISO);

  const demandPlan = input.demandPlan || null;
  const targetsOutput = input.targetsOutput || null;
  const gapActionsOutput = input.gapActionsOutput || null;

  const sources = collectGardenSourceLines({
    demandPlan,
    targetsOutput,
    gapActionsOutput,
    componentsById,
  });

  const rulesApplied = [];
  const notes = [];
  const blockers = [];
  const risks = [];

  if (!sources.length) {
    notes.push("No provisioning gaps/targets found to derive garden targets.");
    return {
      meta: {
        householdId,
        startISO,
        horizonDays,
        builtAtISO: new Date().toISOString(),
        source: SOURCE,
      },
      targets: [],
      summary: { totalSqft: 0, totalPlants: 0, totalPackets: 0 },
      issues: { blockers, risks },
      trace: { notes, rulesApplied },
    };
  }

  const targets = [];

  for (const line of sources) {
    const component = componentsById.get(toLower(line.componentId)) || null;
    if (!component) continue;

    // Determine crop candidates
    const candidates = getCropCandidatesForComponent(
      component,
      mappings,
      cropsById,
      opts,
      climate,
      rulesApplied
    );

    if (!candidates.length) {
      risks.push({
        title: "No crop mapping for component",
        severity: 2,
        detail: `Component "${
          component.name || component.id
        }" has no crop mapping; cannot derive planting precisely.`,
        domain: "garden",
        code: "garden.no_mapping",
      });
      // We can still create a generic target using component itself as "crop"
      const generic = buildGenericGardenTargetFromComponent(
        line,
        component,
        opts,
        climate,
        startISO,
        horizonDays,
        equipment
      );
      if (generic) targets.push(generic);
      continue;
    }

    // Pick up to N best candidates
    const selected = rankCropCandidates(candidates, opts, climate).slice(
      0,
      opts.cropSelection.maxCandidatesPerComponent
    );

    for (const cand of selected) {
      const crop = cand.crop;
      const gt = buildTargetForCrop({
        line,
        component,
        crop,
        weight: cand.weight,
        opts,
        climate,
        startISO,
        horizonDays,
        equipment,
        rulesApplied,
      });
      if (gt) targets.push(gt);
      if (targets.length >= opts.maxTargets) break;
    }
    if (targets.length >= opts.maxTargets) break;
  }

  // Capacity check
  const totalSqft = sum(targets.map((t) => toNum(t.planting?.sqft, 0)));
  const capSqft = toNum(equipment.capacities.garden_sqft, 0);
  if (capSqft > 0 && totalSqft > capSqft * 1.1) {
    blockers.push({
      title: "Garden bed space insufficient",
      severity: 5,
      detail: `Targets require ~${Math.round(
        totalSqft
      )} sqft but capacity is ${Math.round(capSqft)} sqft.`,
      domain: "garden",
      code: "garden.capacity_blocked",
    });
    notes.push(
      "Garden capacity exceeded; consider reducing targets, selecting higher-yield crops, or expanding beds."
    );
  } else if (capSqft > 0 && totalSqft > capSqft * 0.9) {
    risks.push({
      title: "Garden bed space tight",
      severity: 3,
      detail: `Targets require ~${Math.round(
        totalSqft
      )} sqft (capacity ${Math.round(capSqft)} sqft).`,
      domain: "garden",
      code: "garden.capacity_tight",
    });
  } else if (capSqft <= 0) {
    risks.push({
      title: "Garden capacity not set",
      severity: 2,
      detail:
        "Set garden_sqft in equipment profile to validate planting feasibility.",
      domain: "garden",
      code: "garden.capacity_missing",
    });
  }

  const totalPlants = sum(targets.map((t) => toNum(t.planting?.plants, 0)));
  const totalPackets = sum(targets.map((t) => toNum(t.planting?.packets, 0)));

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
      totalSqft: round1(totalSqft),
      totalPlants: Math.round(totalPlants),
      totalPackets: Math.round(totalPackets),
      capacitySqft: capSqft,
    },
    issues: { blockers: rankIssues(blockers), risks: rankIssues(risks) },
    trace: { notes, rulesApplied: uniq(rulesApplied) },
  };
}

export function summarize(output) {
  const o = output || {};
  const t = Array.isArray(o.targets) ? o.targets : [];
  return [
    `Garden targets: ${t.length}`,
    `Total sqft: ${o.summary?.totalSqft || 0} (cap ${
      o.summary?.capacitySqft || 0
    })`,
    `Plants: ${o.summary?.totalPlants || 0} • Packets: ${
      o.summary?.totalPackets || 0
    }`,
  ];
}

/* -----------------------------------------------------------------------------
 * Source lines: where do garden targets come from?
 * --------------------------------------------------------------------------- */

function collectGardenSourceLines({
  demandPlan,
  targetsOutput,
  gapActionsOutput,
  componentsById,
}) {
  // Priority:
  // 1) demandPlan.gaps (category produce/garden-tag)
  // 2) gapActionsOutput actions of type plant
  // 3) targetsOutput.provisioning (produce-tagged)
  const out = [];

  // demandPlan gaps
  const gaps = Array.isArray(demandPlan?.gaps) ? demandPlan.gaps : [];
  for (const g of gaps) {
    const gapQty = Math.max(0, toNum(g.gapQty, 0));
    if (gapQty <= 0) continue;
    const component = componentsById.get(toLower(g.componentId));
    if (!component) continue;
    if (!isGardenEligibleComponent(component)) continue;

    out.push({
      source: "demandPlan.gaps",
      componentId: g.componentId,
      qty: gapQty,
      unit: normalizeUnit(g.unit || component?.defaults?.unit || "each"),
      requiredQty: toNum(g.requiredQty, 0),
      byISO: g.byISO || null,
    });
  }

  // plant actions (already filtered)
  const actions = Array.isArray(gapActionsOutput?.actions)
    ? gapActionsOutput.actions
    : [];
  for (const a of actions) {
    if (a.type !== "plant") continue;
    const component = componentsById.get(toLower(a.componentId));
    if (!component) continue;
    if (!isGardenEligibleComponent(component)) continue;

    out.push({
      source: "gapActions.plant",
      componentId: a.componentId,
      qty: Math.max(0, toNum(a.qty, 0)),
      unit: normalizeUnit(a.unit || component?.defaults?.unit || "each"),
      requiredQty: null,
      byISO: a.links?.payload?.byISO || null,
    });
  }

  // provisioning targets (as fallback)
  const prov = Array.isArray(targetsOutput?.provisioning)
    ? targetsOutput.provisioning
    : [];
  for (const p of prov) {
    const component = componentsById.get(toLower(p.componentId));
    if (!component) continue;
    if (!isGardenEligibleComponent(component)) continue;

    out.push({
      source: "targetsOutput.provisioning",
      componentId: p.componentId,
      qty: Math.max(0, toNum(p.qty, 0)),
      unit: normalizeUnit(p.unit || component?.defaults?.unit || "each"),
      requiredQty: null,
      byISO: p.byISO || null,
    });
  }

  // de-dupe by component + unit (sum qty)
  const map = new Map();
  for (const l of out) {
    const k = `${toLower(l.componentId)}|${normalizeUnit(l.unit)}`;
    const prev = map.get(k);
    if (!prev) map.set(k, { ...l });
    else {
      prev.qty += toNum(l.qty, 0);
      // keep earliest byISO if present
      if (!prev.byISO && l.byISO) prev.byISO = l.byISO;
    }
  }

  return Array.from(map.values()).filter((x) => x.qty > 0);
}

function isGardenEligibleComponent(component) {
  const tags = normalizeStringArray(component?.tags).map(toLower);
  // if component declares it is gardenable explicitly
  if (component?.garden?.enabled === true) return true;
  if (
    tags.some((t) =>
      [
        "vegetable",
        "fruit",
        "herb",
        "produce",
        "grain",
        "legume",
        "bean",
      ].includes(t)
    )
  )
    return true;
  return false;
}

/* -----------------------------------------------------------------------------
 * Crop candidate selection & ranking
 * --------------------------------------------------------------------------- */

function normalizeMappings(catalog) {
  const m =
    catalog?.mappings && typeof catalog.mappings === "object"
      ? catalog.mappings
      : {};
  const componentToCrops =
    m.componentToCrops && typeof m.componentToCrops === "object"
      ? m.componentToCrops
      : {};
  return { componentToCrops };
}

function getCropCandidatesForComponent(
  component,
  mappings,
  cropsById,
  opts,
  climate,
  rulesApplied
) {
  const cid = toLower(component.id);
  const direct = Array.isArray(component?.garden?.crops)
    ? component.garden.crops
    : null;

  const mapped =
    mappings.componentToCrops[cid] ||
    mappings.componentToCrops[component.id] ||
    null;
  const list = [];

  const pushCandidate = (cropId, weight, notes) => {
    const crop = cropsById.get(toLower(cropId));
    if (!crop) return;
    list.push({ crop, weight: toNum(weight, 1), notes: safeStr(notes || "") });
  };

  if (Array.isArray(direct) && direct.length) {
    for (const c of direct) {
      if (typeof c === "string") pushCandidate(c, 1, "component.garden.crops");
      else if (c && typeof c === "object")
        pushCandidate(
          c.cropId || c.id,
          c.weight || 1,
          c.notes || "component.garden.crops"
        );
    }
    rulesApplied.push("Used component.garden.crops mappings.");
  }

  if (Array.isArray(mapped) && mapped.length) {
    for (const c of mapped) {
      if (typeof c === "string")
        pushCandidate(c, 1, "mappings.componentToCrops");
      else if (c && typeof c === "object")
        pushCandidate(
          c.cropId || c.id,
          c.weight || 1,
          c.notes || "mappings.componentToCrops"
        );
    }
    rulesApplied.push("Used catalog.mappings.componentToCrops mappings.");
  }

  // Fallback: try match by tags/name (weak)
  if (!list.length) {
    const componentTags = new Set(
      normalizeStringArray(component?.tags).map(toLower)
    );
    for (const [_, crop] of cropsById.entries()) {
      const cropTags = normalizeStringArray(crop?.tags).map(toLower);
      // basic overlap
      const overlap = cropTags.filter((t) => componentTags.has(t)).length;
      if (overlap > 0)
        list.push({ crop, weight: overlap, notes: "tag overlap fallback" });
    }
    if (list.length)
      rulesApplied.push("Used tag-overlap fallback crop matching.");
  }

  // de-dupe by crop id (keep best weight)
  const map = new Map();
  for (const c of list) {
    const id = toLower(c.crop.id);
    const prev = map.get(id);
    if (!prev || prev.weight < c.weight) map.set(id, c);
  }
  return Array.from(map.values());
}

function rankCropCandidates(candidates, opts, climate) {
  const scored = candidates.map((c) => {
    const within = withinSeasonWindow(c.crop, climate);
    const maturity = toNum(c.crop.daysToMaturity, 60);
    const score =
      c.weight * 10 +
      (opts.cropSelection.preferInSeason ? (within ? 15 : -10) : 0) +
      (opts.cropSelection.preferShorterMaturity
        ? clampNum(30 / Math.max(30, maturity), 0, 1) * 10
        : 0);
    return { ...c, _score: score, _within: within };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

/* -----------------------------------------------------------------------------
 * Build target
 * --------------------------------------------------------------------------- */

function buildTargetForCrop({
  line,
  component,
  crop,
  weight,
  opts,
  climate,
  startISO,
  horizonDays,
  equipment,
  rulesApplied,
}) {
  const componentId = safeStr(component.id);
  const componentName = safeStr(component.name || componentId);
  const cropId = safeStr(crop.id);
  const cropName = safeStr(crop.name || cropId);

  const requiredQty = Math.max(0, toNum(line.qty, 0));
  const requiredUnit = normalizeUnit(
    line.unit || component?.defaults?.unit || "each"
  );

  // Normalize to a "harvest unit" (prefer crop.harvestUnit else component unit)
  const harvestUnit = normalizeUnit(
    crop?.yield?.unit || crop?.harvestUnit || requiredUnit
  );
  const harvestQty = convertGardenNeed(
    requiredQty,
    requiredUnit,
    harvestUnit,
    opts
  );

  const yields = normalizeYield(crop, opts);
  const spacing = normalizeSpacing(crop, opts);

  // Compute planting requirements:
  // Prefer perPlant -> plants, else perSqft -> sqft, else perRowFt -> rowFt
  const assumptions = [];
  const explain = [];

  let plants = 0;
  let sqft = 0;
  let rowFt = 0;

  if (Number.isFinite(yields.perPlant) && yields.perPlant > 0) {
    plants = harvestQty / yields.perPlant;
    // Adjust for germination
    const adjPlants = plants / Math.max(0.1, spacing.germinationRate);
    plants = adjPlants;
    sqft = plants * spacing.sqftPerPlant;
    rowFt = plants * spacing.rowFtPerPlant;
    explain.push(
      `Using yield per plant: need ${fmtQty(
        harvestQty
      )} ${harvestUnit} / ${fmtQty(yields.perPlant)} per plant ≈ ${Math.ceil(
        plants
      )} plants.`
    );
    assumptions.push("Used crop.yield.perPlant (or fallback).");
  } else if (Number.isFinite(yields.perSqft) && yields.perSqft > 0) {
    sqft = harvestQty / yields.perSqft;
    plants = sqft / Math.max(0.1, spacing.sqftPerPlant);
    rowFt = plants * spacing.rowFtPerPlant;
    explain.push(
      `Using yield per sqft: need ${fmtQty(
        harvestQty
      )} ${harvestUnit} / ${fmtQty(yields.perSqft)} per sqft ≈ ${Math.ceil(
        sqft
      )} sqft.`
    );
    assumptions.push("Used crop.yield.perSqft (or fallback).");
  } else if (Number.isFinite(yields.perRowFt) && yields.perRowFt > 0) {
    rowFt = harvestQty / yields.perRowFt;
    plants = rowFt / Math.max(0.1, spacing.rowFtPerPlant);
    sqft = plants * spacing.sqftPerPlant;
    explain.push(
      `Using yield per row-ft: need ${fmtQty(
        harvestQty
      )} ${harvestUnit} / ${fmtQty(yields.perRowFt)} per row-ft ≈ ${Math.ceil(
        rowFt
      )} row-ft.`
    );
    assumptions.push("Used crop.yield.perRowFt (or fallback).");
  } else {
    // total fallback
    plants = harvestQty / Math.max(0.1, opts.yieldDefaults.perPlant);
    sqft = plants * spacing.sqftPerPlant;
    rowFt = plants * spacing.rowFtPerPlant;
    assumptions.push("Used global yield fallback (no crop yields).");
    explain.push("No crop yield data found; used safe default assumptions.");
  }

  plants = clampNum(plants, 0, 1e9);
  sqft = clampNum(sqft, 0, 1e9);
  rowFt = clampNum(rowFt, 0, 1e9);

  const packets = estimateSeedPackets(plants, spacing);

  // Timing
  const daysToMaturity = toNum(crop.daysToMaturity, 60);
  const harvestWindowDays = toNum(
    crop.harvestWindowDays || crop.harvest_window_days,
    toNum(crop.harvestWindowDays, 21)
  );
  const idealStartISO = pickIdealPlantingStart(crop, climate, startISO);
  const latestStartISO = addDaysISO(
    idealStartISO,
    Math.max(0, horizonDays - daysToMaturity)
  );
  const withinSeason = withinSeasonWindow(crop, climate);

  // Succession
  const succession = buildSuccessionSchedule({
    crop,
    startISO: idealStartISO,
    horizonDays,
    daysToMaturity,
    harvestWindowDays,
    opts,
  });

  // Effort
  const minutes = Math.round(
    sqft * opts.effort.minutesPerSqft + plants * opts.effort.minutesPerPlant
  );
  const effort = {
    minutes: clampNum(minutes, 5, 2400),
    difficulty: opts.effort.difficulty,
  };

  // Confidence
  let confidence = 0.6;
  if (
    crop?.yield &&
    (Number.isFinite(crop.yield.perPlant) ||
      Number.isFinite(crop.yield.perSqft) ||
      Number.isFinite(crop.yield.perRowFt))
  )
    confidence += 0.15;
  if (
    crop?.spacing &&
    (Number.isFinite(crop.spacing.sqftPerPlant) ||
      Number.isFinite(crop.spacing.rowFtPerPlant))
  )
    confidence += 0.1;
  if (withinSeason) confidence += 0.1;
  confidence = clampNum(confidence, 0, 1);

  const id = `garden:${componentId}:${cropId}:${hashTiny(
    `${componentId}|${cropId}|${requiredQty}|${requiredUnit}`
  )}`;

  const links = {
    to: "/homesteadplanner/garden-targets",
    payload: {
      componentId,
      cropId,
      requiredQty,
      requiredUnit,
      harvestQty,
      harvestUnit,
      plants: Math.ceil(plants),
      sqft: round1(sqft),
      rowFt: round1(rowFt),
      packets: Math.ceil(packets),
      idealStartISO,
      succession,
      derivedFrom: line.source,
    },
  };

  explain.unshift(
    `Derived from ${line.source} for component "${componentName}".`
  );
  if (!withinSeason)
    explain.push(
      "Warning: crop may be out of season for the current climate window."
    );

  rulesApplied.push(
    "Built garden targets from component gaps using crop yield + spacing."
  );

  return {
    id,
    componentId,
    componentName,
    cropId,
    cropName,
    requiredQty,
    requiredUnit,
    harvestQty: round1(harvestQty),
    harvestUnit,
    planting: {
      plants: Math.ceil(plants),
      sqft: round1(sqft),
      rowFt: round1(rowFt),
      packets: Math.ceil(packets),
      succession,
    },
    timing: {
      idealStartISO,
      latestStartISO,
      daysToMaturity,
      harvestWindowDays,
      withinSeason,
    },
    confidence,
    effort,
    assumptions,
    explain,
    links,
  };
}

function buildGenericGardenTargetFromComponent(
  line,
  component,
  opts,
  climate,
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
  const harvestQty = requiredQty;
  const harvestUnit = requiredUnit;

  // Use generic perSqft
  const perSqft = opts.yieldDefaults.perSqft;
  const sqft = harvestQty / Math.max(0.01, perSqft);
  const plants = sqft / Math.max(0.1, opts.spacingDefaults.sqftPerPlant);
  const packets = estimateSeedPackets(plants, opts.spacingDefaults);

  const idealStartISO = addDaysISO(startISO, 3);
  const withinSeason = opts.seasonFallback.assumeWithinSeason;

  const id = `garden:${componentId}:generic:${hashTiny(
    `${componentId}|generic|${requiredQty}|${requiredUnit}`
  )}`;

  return {
    id,
    componentId,
    componentName,
    cropId: null,
    cropName: componentName,
    requiredQty,
    requiredUnit,
    harvestQty: round1(harvestQty),
    harvestUnit,
    planting: {
      plants: Math.ceil(plants),
      sqft: round1(sqft),
      rowFt: round1(plants * opts.spacingDefaults.rowFtPerPlant),
      packets: Math.ceil(packets),
      succession: buildSuccessionSchedule({
        crop: null,
        startISO: idealStartISO,
        horizonDays,
        daysToMaturity: 60,
        harvestWindowDays: 21,
        opts,
      }),
    },
    timing: {
      idealStartISO,
      latestStartISO: addDaysISO(idealStartISO, Math.max(0, horizonDays - 60)),
      daysToMaturity: 60,
      harvestWindowDays: 21,
      withinSeason,
    },
    confidence: 0.35,
    effort: {
      minutes: clampNum(Math.round(sqft * opts.effort.minutesPerSqft), 5, 2400),
      difficulty: opts.effort.difficulty,
    },
    assumptions: ["No crop mapping; used generic yield + spacing assumptions."],
    explain: [
      `Derived from ${line.source}. No crop mapping found for "${componentName}".`,
      "Used default yield per sqft and spacing.",
    ],
    links: {
      to: "/homesteadplanner/garden-targets",
      payload: {
        componentId,
        cropId: null,
        requiredQty,
        requiredUnit,
        plants: Math.ceil(plants),
        sqft: round1(sqft),
        packets: Math.ceil(packets),
        idealStartISO,
        derivedFrom: line.source,
      },
    },
  };
}

/* -----------------------------------------------------------------------------
 * Yield/spacing/time helpers
 * --------------------------------------------------------------------------- */

function normalizeYield(crop, opts) {
  const y = crop?.yield && typeof crop.yield === "object" ? crop.yield : {};
  return {
    perPlant: toNum(
      y.perPlant,
      toNum(y.per_plant, opts.yieldDefaults.perPlant)
    ),
    perSqft: toNum(y.perSqft, toNum(y.per_sqft, opts.yieldDefaults.perSqft)),
    perRowFt: toNum(
      y.perRowFt,
      toNum(y.per_row_ft, opts.yieldDefaults.perRowFt)
    ),
    unit: normalizeUnit(y.unit || crop?.harvestUnit || ""),
  };
}

function normalizeSpacing(crop, opts) {
  const s =
    crop?.spacing && typeof crop.spacing === "object" ? crop.spacing : {};
  const sqftPerPlant = toNum(
    s.sqftPerPlant,
    toNum(s.sqft_per_plant, opts.spacingDefaults.sqftPerPlant)
  );
  const rowFtPerPlant = toNum(
    s.rowFtPerPlant,
    toNum(s.row_ft_per_plant, opts.spacingDefaults.rowFtPerPlant)
  );
  const seedsPerPacket = toNum(
    s.seedsPerPacket,
    toNum(
      s.seeds_per_packet,
      crop?.seed?.seedsPerPacket || opts.spacingDefaults.seedsPerPacket
    )
  );
  const germinationRate = clampNum(
    toNum(
      s.germinationRate,
      toNum(
        s.germination_rate,
        crop?.seed?.germinationRate || opts.spacingDefaults.germinationRate
      )
    ),
    0.1,
    1
  );

  return { sqftPerPlant, rowFtPerPlant, seedsPerPacket, germinationRate };
}

function estimateSeedPackets(plants, spacing) {
  const seedsNeeded = Math.ceil(Math.max(0, plants)); // 1 seed per plant assumption
  const perPacket = Math.max(1, toNum(spacing.seedsPerPacket, 25));
  return seedsNeeded / perPacket;
}

function buildSuccessionSchedule({
  crop,
  startISO,
  horizonDays,
  daysToMaturity,
  harvestWindowDays,
  opts,
}) {
  if (!opts.succession.enabled)
    return { startsISO: [startISO], intervalDays: null, cycles: 1 };

  const cycles = Math.max(
    1,
    toNum(crop?.succession?.cycles, opts.succession.defaultCycles)
  );
  const intervalDays = Math.max(
    opts.succession.minIntervalDays,
    toNum(
      crop?.succession?.intervalDays,
      Math.round((daysToMaturity + harvestWindowDays) / Math.max(1, cycles))
    )
  );

  const startsISO = [startISO];
  let next = startISO;

  for (let i = 1; i < cycles; i++) {
    next = addDaysISO(next, intervalDays);
    // Stop if beyond horizon
    const delta = daysBetweenISO(startISO, next);
    if (delta > horizonDays) break;
    startsISO.push(next);
  }

  return { startsISO, intervalDays, cycles: startsISO.length };
}

function pickIdealPlantingStart(crop, climate, startISO) {
  // If crop has explicit season windows in catalog (month/day), use it; else use startISO
  const seasons =
    crop?.seasons && typeof crop.seasons === "object" ? crop.seasons : null;
  if (!seasons) return startISO;

  const now = new Date(startISO);
  if (Number.isNaN(now.getTime())) return startISO;

  // Basic schema: seasons.planting = [{ startMonth, startDay, endMonth, endDay }]
  const windows = Array.isArray(seasons.planting) ? seasons.planting : [];
  if (!windows.length) return startISO;

  // Find the first window that contains now (or next upcoming)
  const year = now.getUTCFullYear();
  const candidates = windows.map((w) => {
    const s = makeUTCDate(year, w.startMonth, w.startDay);
    const e = makeUTCDate(year, w.endMonth, w.endDay);
    return { s, e };
  });

  // If we’re within any window, start now (or next 3 days)
  for (const w of candidates) {
    if (now >= w.s && now <= w.e) return addDaysISO(startISO, 3);
  }

  // Otherwise pick the next upcoming start
  candidates.sort((a, b) => a.s.getTime() - b.s.getTime());
  for (const w of candidates) {
    if (w.s.getTime() > now.getTime()) return w.s.toISOString();
  }

  // Otherwise, roll to next year's first window
  const w0 = candidates[0];
  if (!w0) return startISO;
  const nextYearStart = makeUTCDate(
    year + 1,
    w0.s.getUTCMonth() + 1,
    w0.s.getUTCDate()
  );
  return nextYearStart.toISOString();
}

function withinSeasonWindow(crop, climate) {
  // If climate profile includes frost dates or zone and crop has season data, evaluate.
  // Otherwise return fallback assumeWithinSeason.
  if (!crop) return DEFAULTS.seasonFallback.assumeWithinSeason;

  const seasons =
    crop?.seasons && typeof crop.seasons === "object" ? crop.seasons : null;
  if (!seasons) return DEFAULTS.seasonFallback.assumeWithinSeason;

  const windows = Array.isArray(seasons.planting) ? seasons.planting : [];
  if (!windows.length) return DEFAULTS.seasonFallback.assumeWithinSeason;

  const now = new Date(climate.nowISO);
  if (Number.isNaN(now.getTime()))
    return DEFAULTS.seasonFallback.assumeWithinSeason;

  const year = now.getUTCFullYear();
  for (const w of windows) {
    const s = makeUTCDate(year, w.startMonth, w.startDay);
    const e = makeUTCDate(year, w.endMonth, w.endDay);
    if (now >= s && now <= e) return true;
  }
  return false;
}

function makeUTCDate(year, month, day) {
  // month is 1..12
  const m = Math.max(1, Math.min(12, toNum(month, 1)));
  const d = Math.max(1, Math.min(31, toNum(day, 1)));
  return new Date(Date.UTC(year, m - 1, d, 0, 0, 0));
}

function daysBetweenISO(aISO, bISO) {
  const a = new Date(aISO);
  const b = new Date(bISO);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function convertGardenNeed(qty, fromUnit, toUnit, opts) {
  const q = toNum(qty, 0);
  const f = normalizeUnit(fromUnit);
  const t = normalizeUnit(toUnit);

  if (f === t) return q;

  // servings -> units (1:1 default)
  if (f === "serving") return q * opts.servingToUnitRatio;

  // if converting between mass/volume units isn't supported here, just passthrough
  return q;
}

/* -----------------------------------------------------------------------------
 * Normalizers
 * --------------------------------------------------------------------------- */

function normalizeEquipment(raw, opts) {
  const capsIn =
    raw?.capacities && typeof raw.capacities === "object" ? raw.capacities : {};
  const capacities = { ...opts.capacityDefaults };
  for (const k of Object.keys(capacities))
    capacities[k] = toNum(capsIn[k], capacities[k]);
  const beds = Array.isArray(raw?.beds) ? raw.beds.map((b) => ({ ...b })) : [];
  return { capacities, beds };
}

function normalizeClimate(raw, startISO) {
  const nowISO = raw?.nowISO || startISO || new Date().toISOString();
  return {
    zone: safeStr(raw?.zone || ""),
    hemisphere: safeStr(raw?.hemisphere || ""),
    lastFrostISO: raw?.lastFrostISO || null,
    firstFrostISO: raw?.firstFrostISO || null,
    nowISO,
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
