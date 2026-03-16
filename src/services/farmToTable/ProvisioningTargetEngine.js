// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\ProvisioningTargetEngine.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead ProvisioningTargetEngine
 * -----------------------------------------------------------------------------
 * Builds "provisioning targets" that drive the Homestead Planner:
 *  - targets.jsx (provisioning targets + gaps + actions)
 *  - garden-targets.jsx (planting targets derived from provisioning)
 *  - animal-targets.jsx (breeding/purchase targets derived from provisioning)
 *  - batches.jsx (start preservation batch from targets)
 *  - inventory.jsx (readiness + shelf life view)
 *
 * This engine is deterministic and explainable; NO AI.
 *
 * Output format is compatible with ComponentDemandBuilder.buildDemandPlan():
 *  {
 *    meta: {...},
 *    provisioning: ProvisioningTarget[],
 *    preservation: PreservationTarget[],
 *    derived: { staples, proteins, produce, beverages, misc },
 *    trace: { assumptions, rulesApplied, notes }
 *  }
 *
 * -----------------------------------------------------------------------------
 * Inputs (flexible)
 * -----------------------------------------------------------------------------
 * buildProvisioningTargets({
 *   householdId,
 *   householdProfile: {
 *     peopleCount, adultsCount, kidsCount,
 *     servingsPerDay?: { breakfast, lunch, dinner, snacks },
 *     mealsPerWeek?: { breakfast, lunch, dinner, snacks },
 *     wasteFactor?: number, // 0.0..0.5
 *   },
 *   horizonDays,
 *   startISO,
 *   catalogBundle,          // CatalogLoader output
 *   inventorySnapshot,      // optional (for readiness; does not affect targets unless options.useInventoryAsBaseline)
 *   cuisineSelection,       // CuisineResolver.resolveActiveCuisine output
 *   resolvedPreferences,    // PreferenceResolver.resolvePreferences output (optional)
 *   ruleset,                // optional provisioning rules (overrides defaults)
 *   options
 * })
 *
 * You can start with minimal householdProfile (peopleCount only) and it will still work.
 */

const SOURCE = "services/farmToTable/ProvisioningTargetEngine";

const DEFAULTS = {
  horizonDays: 28,

  // Baseline meal rhythm
  mealsPerDayDefault: { breakfast: 1, lunch: 1, dinner: 1, snacks: 0.5 },

  // Typical serving sizes expressed in "servings" units.
  // (Unit conversion to pounds/quarts/etc. can be added later.)
  servingUnits: "serving",

  // Category targets expressed as servings per person per day
  perPersonPerDay: {
    staples: 2.0, // grains/starches/bread base
    protein: 1.0,
    produce: 2.0,
    fat: 0.4,
    dairy: 0.3,
    beverage: 1.0, // cups equivalent
    dessert: 0.15,
  },

  // Waste/spoilage factor (adds extra)
  wasteFactor: 0.12,

  // Portion bumpers based on adults/kids split
  personWeights: {
    adult: 1.0,
    kid: 0.7,
  },

  // Catalog matching: tags to category mapping
  tagToCategory: {
    // staples
    grain: "staples",
    starch: "staples",
    bread: "staples",
    flour: "staples",
    rice: "staples",
    pasta: "staples",
    legume: "staples",
    bean: "staples",

    // protein
    meat: "protein",
    poultry: "protein",
    fish: "protein",
    eggs: "protein",
    dairy: "dairy",

    // produce
    vegetable: "produce",
    fruit: "produce",
    produce: "produce",
    herb: "produce",

    // fats
    oil: "fat",
    fat: "fat",
    butter: "fat",

    // beverages
    beverage: "beverage",
    tea: "beverage",
    coffee: "beverage",
    juice: "beverage",
  },

  // Default "staple basket" components, used when catalog doesn't have enough tagging.
  // These are component IDs (preferred) or names as fallback.
  defaultBasket: {
    staples: ["rice", "flour", "cornmeal", "oats", "pasta"],
    protein: ["chicken", "beef", "eggs", "fish"],
    produce: ["onion", "garlic", "greens", "carrot", "cabbage"],
    fat: ["oil", "butter"],
    dairy: ["milk"],
    beverage: ["tea", "coffee"],
  },

  // Preservation strategy default: percent of horizon provisioning to preserve
  preservation: {
    enabled: true,
    // how much of staples/protein/produce to plan to preserve (0..1)
    preserveShareByCategory: {
      staples: 0.15,
      protein: 0.2,
      produce: 0.25,
      fat: 0.0,
      dairy: 0.05,
      beverage: 0.1,
      dessert: 0.0,
    },
    // default target timing (end of horizon)
    byISO: null,
  },

  // How cuisine affects target mix
  cuisineInfluence: {
    enabled: true,
    // apply preferTags from cuisine/preferences to bias basket selection
    tagBiasWeight: 1.5,
  },

  // Whether to build targets as "servings" or keep catalog default units (usually "unit")
  targetUnitMode: "serving", // serving | componentDefault

  // Optional: subtract existing inventory to form "net targets"
  useInventoryAsBaseline: false,

  // If useInventoryAsBaseline true, only subtract items not expiring before horizon end
  inventoryExpiryAware: true,

  // Safeguards
  minQty: 0.000001,
  maxTargets: 500,
};

export const ProvisioningTargetEngine = {
  buildProvisioningTargets,
  buildFromTemplate,
  categorizeComponents,
  chooseBasketForCategory,
  explainTargets,
};

/* -----------------------------------------------------------------------------
 * Main
 * --------------------------------------------------------------------------- */

export function buildProvisioningTargets(input = {}) {
  const opts = mergeOptions(input.options);
  const ruleset = deepMerge({}, opts, input.ruleset || {}); // allow ruleset override

  const householdId = safeStr(input.householdId || "primary");
  const horizonDays = Number.isFinite(input.horizonDays)
    ? input.horizonDays
    : ruleset.horizonDays;
  const startISO = input.startISO || new Date().toISOString();

  const catalog = input.catalogBundle || { components: [], methods: [] };
  const components = Array.isArray(catalog.components)
    ? catalog.components
    : [];

  const householdProfile = normalizeHouseholdProfile(
    input.householdProfile || {},
    ruleset
  );

  // Optional preference/cuisine packs
  const cuisineSelection = input.cuisineSelection || null;
  const preferencesPack = input.resolvedPreferences || null;

  // Build component indices and categories
  const indices = buildCatalogIndices(components);
  const categorized = categorizeComponents(components, ruleset, indices);

  // Build target totals (servings) per category
  const totalsByCategory = computeTotalsByCategory(
    householdProfile,
    horizonDays,
    ruleset,
    cuisineSelection,
    preferencesPack
  );

  // Choose basket components for each category and distribute totals
  const derived = {
    staples: [],
    proteins: [],
    produce: [],
    beverages: [],
    misc: [],
  };

  const provisioning = [];
  const rulesApplied = [];
  const assumptions = [];

  // Assemble per category targets
  for (const cat of Object.keys(totalsByCategory)) {
    const totalServings = totalsByCategory[cat];

    if (!Number.isFinite(totalServings) || totalServings <= 0) continue;

    const basket = chooseBasketForCategory({
      category: cat,
      totalServings,
      categorized,
      indices,
      ruleset,
      cuisineSelection,
      preferencesPack,
    });

    rulesApplied.push(...basket.rulesApplied);

    // Distribute totals across basket
    const dist = distributeAcrossBasket(totalServings, basket.items, ruleset);
    for (const d of dist) {
      provisioning.push(
        toProvisioningTarget(d, ruleset, startISO, horizonDays)
      );
      // derived buckets for UI
      pushDerived(derived, cat, d);
    }
  }

  // Preservation targets (optional)
  const preservation = [];
  if (ruleset.preservation?.enabled) {
    const pres = buildPreservationTargets(
      provisioning,
      ruleset,
      startISO,
      horizonDays
    );
    preservation.push(...pres.targets);
    rulesApplied.push(...pres.rulesApplied);
  }

  // Optional: net targets using inventory baseline
  let netProvisioning = provisioning;
  let netPreservation = preservation;

  if (ruleset.useInventoryAsBaseline && input.inventorySnapshot) {
    const net = applyInventoryBaseline(
      provisioning,
      preservation,
      input.inventorySnapshot,
      indices,
      ruleset,
      startISO,
      horizonDays
    );
    netProvisioning = net.provisioning;
    netPreservation = net.preservation;
    rulesApplied.push(...net.rulesApplied);
  }

  // Clip and sanitize
  netProvisioning = netProvisioning
    .filter((t) => t.qty >= ruleset.minQty)
    .slice(0, ruleset.maxTargets);
  netPreservation = netPreservation
    .filter((t) => t.qty >= ruleset.minQty)
    .slice(0, ruleset.maxTargets);

  return {
    meta: {
      householdId,
      startISO,
      horizonDays,
      builtAtISO: new Date().toISOString(),
      unitMode: ruleset.targetUnitMode,
      source: SOURCE,
    },
    provisioning: netProvisioning,
    preservation: netPreservation,
    derived,
    trace: {
      assumptions,
      rulesApplied,
      householdProfile,
      totalsByCategory,
      cuisine:
        cuisineSelection?.activeCuisineIds ||
        cuisineSelection?.meta?.activeCuisineIds ||
        [],
    },
  };
}

/**
 * Convenience for using named templates (future-proof).
 * For now, it just calls buildProvisioningTargets with ruleset merged.
 */
export function buildFromTemplate(templateKey, input = {}) {
  const templates = {
    // Example template keys – you can expand later
    "baseline-balanced": {},
    "high-preservation": {
      preservation: {
        enabled: true,
        preserveShareByCategory: {
          staples: 0.25,
          protein: 0.25,
          produce: 0.35,
          fat: 0.0,
          dairy: 0.1,
          beverage: 0.15,
          dessert: 0.0,
        },
      },
    },
    "time-scarce": {
      operations: { timePreference: "low" },
    },
  };

  const t = templates[templateKey] || {};
  return buildProvisioningTargets({
    ...input,
    ruleset: deepMerge({}, t, input.ruleset || {}),
  });
}

/* -----------------------------------------------------------------------------
 * Household profile + totals
 * --------------------------------------------------------------------------- */

function normalizeHouseholdProfile(raw, ruleset) {
  const peopleCount = toNum(raw.peopleCount, NaN);
  const adultsCount = toNum(raw.adultsCount, NaN);
  const kidsCount = toNum(raw.kidsCount, NaN);

  // Derive counts if missing
  let adults = Number.isFinite(adultsCount)
    ? adultsCount
    : Number.isFinite(peopleCount)
    ? Math.max(1, Math.round(peopleCount * 0.6))
    : 2;
  let kids = Number.isFinite(kidsCount)
    ? kidsCount
    : Number.isFinite(peopleCount)
    ? Math.max(0, peopleCount - adults)
    : 0;

  const people = Math.max(1, Math.round((adults || 0) + (kids || 0)));

  const wasteFactor = clampNum(raw.wasteFactor, 0, 0.5, ruleset.wasteFactor);

  const mealsPerDay =
    raw.servingsPerDay && typeof raw.servingsPerDay === "object"
      ? {
          breakfast: toNum(
            raw.servingsPerDay.breakfast,
            ruleset.mealsPerDayDefault.breakfast
          ),
          lunch: toNum(
            raw.servingsPerDay.lunch,
            ruleset.mealsPerDayDefault.lunch
          ),
          dinner: toNum(
            raw.servingsPerDay.dinner,
            ruleset.mealsPerDayDefault.dinner
          ),
          snacks: toNum(
            raw.servingsPerDay.snacks,
            ruleset.mealsPerDayDefault.snacks
          ),
        }
      : { ...ruleset.mealsPerDayDefault };

  // Weighted person units for consumption modeling
  const weightedPeople =
    adults * ruleset.personWeights.adult + kids * ruleset.personWeights.kid;

  return {
    peopleCount: people,
    adultsCount: adults,
    kidsCount: kids,
    weightedPeople,
    wasteFactor,
    mealsPerDay,
  };
}

function computeTotalsByCategory(
  householdProfile,
  horizonDays,
  ruleset,
  cuisineSelection,
  preferencesPack
) {
  const per = ruleset.perPersonPerDay || DEFAULTS.perPersonPerDay;
  const wp = householdProfile.weightedPeople;

  // Total meals per day (for possible future scaling)
  const mealsPerDay =
    (householdProfile.mealsPerDay.breakfast || 0) +
    (householdProfile.mealsPerDay.lunch || 0) +
    (householdProfile.mealsPerDay.dinner || 0) +
    (householdProfile.mealsPerDay.snacks || 0);

  // Baseline servings by category
  const totals = {};
  for (const cat of Object.keys(per)) {
    totals[cat] = wp * horizonDays * toNum(per[cat], 0);
  }

  // Apply waste/spoilage multiplier
  const waste = clampNum(
    householdProfile.wasteFactor,
    0,
    0.5,
    ruleset.wasteFactor
  );
  for (const cat of Object.keys(totals)) {
    totals[cat] = totals[cat] * (1 + waste);
  }

  // Optional cuisine influence:
  // If active cuisine indicates higher staples/protein/produce, you can bias.
  // We keep it simple: if preferences favor "fresh" reduce preserved share (handled elsewhere).
  if (ruleset.cuisineInfluence?.enabled && preferencesPack?.scoring) {
    // if timePreference is low (wants quick), shift a bit towards staples/protein and away from produce
    const timePref = preferencesPack.scoring.timePreference;
    if (timePref === "low") {
      totals.staples *= 1.05;
      totals.produce *= 0.95;
      totals.protein *= 1.03;
    }
  }

  // Ensure numeric and non-negative
  for (const k of Object.keys(totals)) {
    totals[k] = Math.max(0, toNum(totals[k], 0));
  }

  return totals;
}

/* -----------------------------------------------------------------------------
 * Catalog indexing + categorization
 * --------------------------------------------------------------------------- */

function buildCatalogIndices(components) {
  const byId = new Map();
  const byName = new Map();
  const byTag = new Map(); // tagLower -> component[]
  const byCategory = new Map(); // categoryLower -> component[]

  for (const c of components || []) {
    if (!c) continue;
    const id = safeStr(c.id);
    const name = safeStr(c.name);
    if (id) byId.set(toLower(id), c);
    if (name) byName.set(toLower(name), c);

    const tags = normalizeStringArray(c.tags).map(toLower);
    for (const t of tags) {
      const arr = byTag.get(t) || [];
      arr.push(c);
      byTag.set(t, arr);
    }

    const cat = toLower(c.category || "");
    if (cat) {
      const arr = byCategory.get(cat) || [];
      arr.push(c);
      byCategory.set(cat, arr);
    }
  }

  return { byId, byName, byTag, byCategory };
}

/**
 * Categorize components into provisioning categories using tags first,
 * falling back to component.category text and defaultBasket.
 */
export function categorizeComponents(components, ruleset, indices) {
  const out = {
    staples: [],
    protein: [],
    produce: [],
    fat: [],
    dairy: [],
    beverage: [],
    dessert: [],
    unknown: [],
  };

  const tagMap = ruleset.tagToCategory || DEFAULTS.tagToCategory;

  for (const c of components || []) {
    const tags = normalizeStringArray(c.tags).map(toLower);
    let cat = null;

    for (const t of tags) {
      const mapped = tagMap[t];
      if (mapped) {
        cat = mapped;
        break;
      }
    }

    if (!cat) {
      const ccat = toLower(c.category || "");
      // simple mapping by category keywords
      if (ccat.includes("grain") || ccat.includes("staple")) cat = "staples";
      else if (ccat.includes("protein") || ccat.includes("meat"))
        cat = "protein";
      else if (
        ccat.includes("produce") ||
        ccat.includes("veg") ||
        ccat.includes("fruit") ||
        ccat.includes("herb")
      )
        cat = "produce";
      else if (ccat.includes("fat") || ccat.includes("oil")) cat = "fat";
      else if (ccat.includes("dairy")) cat = "dairy";
      else if (ccat.includes("beverage") || ccat.includes("drink"))
        cat = "beverage";
      else if (ccat.includes("dessert") || ccat.includes("sweet"))
        cat = "dessert";
    }

    if (!cat || !out[cat]) cat = "unknown";
    out[cat].push(c);
  }

  // Stable sort by name
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  return out;
}

/* -----------------------------------------------------------------------------
 * Basket selection + distribution
 * --------------------------------------------------------------------------- */

export function chooseBasketForCategory(args) {
  const {
    category,
    totalServings,
    categorized,
    indices,
    ruleset,
    cuisineSelection,
    preferencesPack,
  } = args;

  const rulesApplied = [];

  // Start with tagged components for this category
  let candidates = categorized?.[category] || [];

  // If empty, fall back to default basket IDs/names
  if (!candidates.length) {
    const def =
      ruleset.defaultBasket?.[category] ||
      DEFAULTS.defaultBasket?.[category] ||
      [];
    const picked = [];
    for (const key of def) {
      const c =
        indices.byId.get(toLower(key)) ||
        indices.byName.get(toLower(key)) ||
        null;
      if (c) picked.push(c);
    }
    candidates = picked;
    rulesApplied.push(`Fallback basket for "${category}" used defaultBasket.`);
  }

  // Cuisine + preference bias: preferTags increase candidate ranking
  let preferTags = [];
  if (ruleset.cuisineInfluence?.enabled) {
    preferTags = uniqLower([
      ...(preferencesPack?.scoring?.likedTags || []),
      ...(preferencesPack?.scoring?.preferMethods || []), // sometimes method ids used as tags; harmless
      ...(preferencesPack?.resolved?.cuisine?.weights?.preferTags || []),
      ...(preferencesPack?.scoring?.context?.likedTags || []),
    ]);
  }

  const biasW = toNum(
    ruleset.cuisineInfluence?.tagBiasWeight,
    DEFAULTS.cuisineInfluence.tagBiasWeight
  );

  const ranked = candidates
    .map((c) => ({ c, score: scoreCandidateByTags(c, preferTags) * biasW }))
    .sort((a, b) => b.score - a.score);

  const maxItems = category === "produce" ? 8 : category === "staples" ? 6 : 5;
  const picked = ranked
    .slice(0, Math.min(maxItems, ranked.length))
    .map((x) => x.c);

  if (preferTags.length) {
    rulesApplied.push(
      `Applied tag bias for "${category}" using preferTags (${preferTags
        .slice(0, 8)
        .join(", ")}${preferTags.length > 8 ? "…" : ""}).`
    );
  }

  return {
    category,
    items: picked,
    rulesApplied,
  };
}

function scoreCandidateByTags(component, preferTagsLower) {
  if (!preferTagsLower?.length) return 0;
  const tags = normalizeStringArray(component.tags).map(toLower);
  let s = 0;
  for (const t of preferTagsLower) {
    if (tags.includes(t)) s += 1;
  }
  return s;
}

/**
 * Distribute totalServings across basket items.
 * Currently even distribution with slight preference for the first item.
 */
function distributeAcrossBasket(totalServings, items, ruleset) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length || totalServings <= 0) return [];

  // Even split, first gets +10%
  const n = list.length;
  const base = totalServings / n;

  const out = [];
  for (let i = 0; i < n; i++) {
    let qty = base;
    if (i === 0 && n > 1) qty = base * 1.1;
    out.push({
      componentId: list[i].id,
      componentName: list[i].name,
      qty,
      unit:
        ruleset.targetUnitMode === "componentDefault"
          ? list[i].defaults?.unit || "unit"
          : ruleset.servingUnits,
      cadence: "weekly",
      notes: "",
      _component: list[i],
      _category: inferCategoryFromComponent(list[i], ruleset),
    });
  }

  // Renormalize so sums match exactly
  const sum = out.reduce((a, b) => a + b.qty, 0);
  const scale = sum > 0 ? totalServings / sum : 1;
  for (const r of out) r.qty *= scale;

  return out;
}

function inferCategoryFromComponent(c, ruleset) {
  const tagMap = ruleset.tagToCategory || DEFAULTS.tagToCategory;
  const tags = normalizeStringArray(c.tags).map(toLower);
  for (const t of tags) {
    if (tagMap[t]) return tagMap[t];
  }
  const ccat = toLower(c.category || "");
  if (ccat.includes("grain") || ccat.includes("staple")) return "staples";
  if (ccat.includes("protein") || ccat.includes("meat")) return "protein";
  if (
    ccat.includes("produce") ||
    ccat.includes("veg") ||
    ccat.includes("fruit") ||
    ccat.includes("herb")
  )
    return "produce";
  if (ccat.includes("fat") || ccat.includes("oil")) return "fat";
  if (ccat.includes("dairy")) return "dairy";
  if (ccat.includes("beverage") || ccat.includes("drink")) return "beverage";
  if (ccat.includes("dessert") || ccat.includes("sweet")) return "dessert";
  return "unknown";
}

/* -----------------------------------------------------------------------------
 * Target shaping
 * --------------------------------------------------------------------------- */

function toProvisioningTarget(distRow, ruleset, startISO, horizonDays) {
  const cadence = distRow.cadence || "weekly";

  // Convert servings totals into qty per cadence window:
  // We keep weekly cadence by default, representing "per week over horizon".
  // qty here is "per week" amount.
  // For horizonDays not multiple of 7, treat as average week.
  const weeks = horizonDays / 7;
  const perWeekQty = distRow.qty / Math.max(weeks, 1);

  return {
    componentId: distRow.componentId,
    name: distRow.componentName,
    qty: perWeekQty,
    unit: distRow.unit,
    cadence,
    startISO,
    endISO: addDaysISO(startISO, horizonDays),
    notes: distRow.notes || "",
    meta: {
      category: distRow._category || "unknown",
      unitMode: ruleset.targetUnitMode,
      computedFrom: "category_servings",
    },
  };
}

function pushDerived(derived, category, distRow) {
  const entry = {
    componentId: distRow.componentId,
    name: distRow.componentName,
    qty: distRow.qty,
    unit: distRow.unit,
    category,
  };

  if (category === "staples") derived.staples.push(entry);
  else if (category === "protein") derived.proteins.push(entry);
  else if (category === "produce") derived.produce.push(entry);
  else if (category === "beverage") derived.beverages.push(entry);
  else derived.misc.push(entry);
}

/* -----------------------------------------------------------------------------
 * Preservation targets
 * --------------------------------------------------------------------------- */

function buildPreservationTargets(
  provisioning,
  ruleset,
  startISO,
  horizonDays
) {
  const rulesApplied = [];
  const share =
    ruleset.preservation?.preserveShareByCategory ||
    DEFAULTS.preservation.preserveShareByCategory;
  const byISO =
    ruleset.preservation?.byISO || addDaysISO(startISO, horizonDays);

  const targets = [];

  for (const p of provisioning || []) {
    const cat = p.meta?.category || "unknown";
    const s = toNum(share[cat], 0);
    if (s <= 0) continue;

    targets.push({
      componentId: p.componentId,
      name: p.name,
      qty: p.qty * s,
      unit: p.unit,
      byISO,
      priority: cat === "produce" ? "high" : "medium",
      notes: `Preserve ~${Math.round(s * 100)}% of ${cat} target.`,
      meta: { derivedFrom: "provisioning", category: cat },
    });
  }

  rulesApplied.push(
    "Built preservation targets from provisioning targets using preserveShareByCategory."
  );
  return { targets, rulesApplied };
}

/* -----------------------------------------------------------------------------
 * Inventory baseline (optional net targets)
 * --------------------------------------------------------------------------- */

function applyInventoryBaseline(
  provisioning,
  preservation,
  inventorySnapshot,
  indices,
  ruleset,
  startISO,
  horizonDays
) {
  const rulesApplied = [];
  const invItems = Array.isArray(inventorySnapshot?.items)
    ? inventorySnapshot.items
    : [];
  const horizonEnd = new Date(
    toDate(startISO).getTime() + horizonDays * 86400000
  );

  // Index inventory by componentId+unit
  const invByKey = new Map();
  for (const it of invItems) {
    const cid = safeStr(it.componentId || it.id);
    if (!cid) continue;
    const unit = normalizeUnit(it.unit || "unit");
    const key = `${toLower(cid)}|${unit}`;

    const exp = it.expiresAtISO ? toDate(it.expiresAtISO) : null;
    if (ruleset.inventoryExpiryAware && exp && exp < horizonEnd) continue;

    invByKey.set(key, (invByKey.get(key) || 0) + toNum(it.qty, 0));
  }

  function subtractBaseline(list, label) {
    const out = [];
    for (const t of list || []) {
      const unit = normalizeUnit(t.unit);
      const key = `${toLower(t.componentId)}|${unit}`;
      const have = invByKey.get(key) || 0;

      const net = Math.max(0, toNum(t.qty, 0) - have);
      out.push({
        ...t,
        qty: net,
        meta: {
          ...(t.meta || {}),
          baselineSubtracted: true,
          baselineQty: have,
        },
      });
    }
    rulesApplied.push(`Subtracted inventory baseline from ${label} targets.`);
    return out;
  }

  return {
    provisioning: subtractBaseline(provisioning, "provisioning"),
    preservation: subtractBaseline(preservation, "preservation"),
    rulesApplied,
  };
}

/* -----------------------------------------------------------------------------
 * Explainability
 * --------------------------------------------------------------------------- */

export function explainTargets(targetOutput) {
  const out = targetOutput || {};
  const meta = out.meta || {};
  const trace = out.trace || {};

  const lines = [];
  lines.push(
    `Horizon: ${meta.horizonDays || "?"} days starting ${meta.startISO || "?"}`
  );
  if (trace.householdProfile) {
    const hp = trace.householdProfile;
    lines.push(
      `Household: ${hp.peopleCount} people (weighted ${
        hp.weightedPeople?.toFixed?.(2) || hp.weightedPeople
      }). Waste factor: ${(hp.wasteFactor * 100).toFixed(0)}%.`
    );
  }
  if (trace.totalsByCategory) {
    const parts = Object.keys(trace.totalsByCategory).map(
      (k) => `${k}:${Math.round(trace.totalsByCategory[k])}`
    );
    lines.push(`Category totals (servings): ${parts.join(" • ")}`);
  }
  if (Array.isArray(trace.rulesApplied) && trace.rulesApplied.length) {
    lines.push(...trace.rulesApplied.map((r) => `• ${r}`));
  }
  return lines;
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

    if (Array.isArray(sv)) {
      out[k] = sv.slice();
    } else if (sv && typeof sv === "object") {
      out[k] = deepMerge(
        tv && typeof tv === "object" && !Array.isArray(tv) ? tv : {},
        sv
      );
    } else {
      out[k] = sv;
    }
  }
  return out;
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

function uniqLower(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = toLower(x);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, min, max, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function addDaysISO(startISO, days) {
  const d = toDate(startISO);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString();
}

function toDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function normalizeUnit(unit) {
  return safeStr(unit || "unit").toLowerCase();
}
