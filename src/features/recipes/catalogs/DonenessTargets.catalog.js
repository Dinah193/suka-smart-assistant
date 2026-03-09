/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\catalogs\DonenessTargets.catalog.js
//
// SSA • Doneness Targets Catalog
// -----------------------------------------------------------------------------
// Purpose:
//   Central, deterministic doneness & safety targets used by RecipeAdapterService
//   and CookPlan compilation.
//
// What this catalog provides:
//   - A normalized set of doneness profiles per protein/cut/method
//   - Recommended "target" internal temperatures (°F) with tolerance
//   - Safety minimums (°F) enforced by SSA when user targets are below safety
//   - Doneness labels mapped to temperatures (e.g., rare/medium/well) per protein
//
// Design notes:
//   - Temperatures stored in Fahrenheit for determinism.
//   - This file intentionally does NOT cite external authorities; it provides
//     consistent default rules for SSA. You may plug in an authority layer later
//     (USDA/ServSafe/ etc.) as an optional verification layer.
//
// API:
//   getDonenessRule(query)         -> best matching rule (most specific)
//   resolveDonenessTargets(query)  -> computed target + safety enforcement + source
//   getDonenessTarget(query)       -> convenience alias (returns resolution object)
//   listDonenessRules(filter)      -> list rules (debug/UI)
//   listDonenessLabels(protein)    -> label map for UI (rare/med/etc.)
//   explainDonenessResolution(...) -> human readable explanation
//
// Query shape (typical):
//   {
//     proteinCategory: "beef"|"chicken"|...,
//     cutTag: "steak"|"ground"|...,
//     method: "grill"|"roast"|...,
//     donenessPreference: "medium"|"well"|"target:165"|"label:medium_rare"|null,
//     householdOverrides: { targetInternalTempF?: number, toleranceF?: number } | null,
//     enforceSafetyMinimum: true|false
//   }

const CATALOG_ID = "ssa://catalogs/recipes/doneness-targets#v1";
const CATALOG_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

const PROTEIN_CATEGORIES = [
  "beef",
  "lamb",
  "goat",
  "venison",
  "bison",
  "pork",
  "chicken",
  "turkey",
  "duck",
  "fish",
  "shellfish",
  "eggs",
  "mixed",
  "unknown",
];

const CUT_TAGS = [
  "whole",
  "ground",
  "steak",
  "chops",
  "roast",
  "ribs",
  "breast",
  "thigh",
  "wings",
  "drumsticks",
  "tenderloin",
  "shoulder",
  "leg",
  "loin",
  "belly",
  "fillet",
  "patty",
  "sausage",
  "mixed_cuts",
];

const COOK_METHODS = [
  "bake",
  "roast",
  "broil",
  "grill",
  "smoke",
  "pan_sear",
  "saute",
  "stir_fry",
  "deep_fry",
  "air_fry",
  "braise",
  "stew",
  "poach",
  "simmer",
  "boil",
  "pressure_cook",
  "slow_cook",
  "sous_vide",
  "microwave",
  "no_cook",
];

const DONENESS_LABELS = [
  "raw",
  "rare",
  "medium_rare",
  "medium",
  "medium_well",
  "well",
  "flakes",
  "opaque",
  "set",
  "safe",
];

const DEFAULT_TOLERANCE_F = 3;

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  return Math.round(x * 10) / 10;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function toTempF(value) {
  const x = Number(value);
  if (!Number.isFinite(x)) return undefined;
  return round1(clamp(x, 32, 450));
}

function parseDonenessPreference(pref) {
  // Accept:
  //  - null/"" -> none
  //  - "medium" label
  //  - "label:medium_rare"
  //  - "target:165"
  //  - "165"
  const s = safeLower(pref);
  if (!s) return { type: "none" };

  if (s.startsWith("label:")) {
    const label = s.slice("label:".length).trim();
    return DONENESS_LABELS.includes(label)
      ? { type: "label", label }
      : { type: "none" };
  }
  if (s.startsWith("target:")) {
    const v = toTempF(s.slice("target:".length).trim());
    return v != null ? { type: "target", tempF: v } : { type: "none" };
  }
  if (DONENESS_LABELS.includes(s)) return { type: "label", label: s };

  const maybeNum = toTempF(s);
  if (maybeNum != null) return { type: "target", tempF: maybeNum };

  return { type: "none" };
}

/* -------------------------------------------------------------------------- */
/* Label temperature maps (per protein family)                                 */
/* -------------------------------------------------------------------------- */
/**
 * These maps are used when a user selects a doneness label.
 * Target temps can be overridden by cut/method-specific rules below.
 */
const LABEL_TEMP_MAP = {
  beef: {
    rare: 125,
    medium_rare: 135,
    medium: 145,
    medium_well: 150,
    well: 160,
  },
  lamb: {
    rare: 125,
    medium_rare: 135,
    medium: 145,
    medium_well: 150,
    well: 160,
  },
  goat: {
    rare: 125,
    medium_rare: 135,
    medium: 145,
    medium_well: 150,
    well: 160,
  },
  venison: {
    rare: 120,
    medium_rare: 130,
    medium: 140,
    medium_well: 150,
    well: 160,
  },
  bison: {
    rare: 125,
    medium_rare: 135,
    medium: 145,
    medium_well: 150,
    well: 160,
  },
  pork: {
    medium: 145,
    well: 160,
    safe: 145,
  },
  chicken: {
    safe: 165,
    well: 170,
  },
  turkey: {
    safe: 165,
    well: 170,
  },
  duck: {
    medium_rare: 135,
    medium: 145,
    well: 165,
    safe: 165,
  },
  fish: {
    flakes: 145,
    opaque: 140,
    safe: 145,
  },
  shellfish: {
    opaque: 145,
    safe: 145,
  },
  eggs: {
    set: 160,
    safe: 160,
  },
};

/* -------------------------------------------------------------------------- */
/* Safety minimums (baseline)                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Safety minimums are the floor SSA enforces unless enforceSafetyMinimum=false.
 * These can be overridden by more specific rules (e.g., ground meats).
 */
const SAFETY_MINIMUMS_F = {
  beef: 145,
  lamb: 145,
  goat: 145,
  venison: 145,
  bison: 145,
  pork: 145,
  chicken: 165,
  turkey: 165,
  duck: 165,
  fish: 145,
  shellfish: 145,
  eggs: 160,
  mixed: 145,
  unknown: 145,
};

function safetyMinimumFor(proteinCategory, cutTag) {
  const p = PROTEIN_CATEGORIES.includes(proteinCategory)
    ? proteinCategory
    : "unknown";
  const c = CUT_TAGS.includes(cutTag) ? cutTag : "whole";

  // Ground/sausage/patties: treat as "higher safety" for most mammals
  if (
    (c === "ground" || c === "patty" || c === "sausage") &&
    [
      "beef",
      "lamb",
      "goat",
      "venison",
      "bison",
      "pork",
      "mixed",
      "unknown",
    ].includes(p)
  ) {
    return 160; // SSA baseline for ground mammal meats
  }

  return SAFETY_MINIMUMS_F[p] ?? 145;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */
/**
 * Rule matching uses specificity:
 *   protein + cut + method is most specific
 *   protein + cut
 *   protein + method
 *   protein only
 *   fallback
 *
 * Each rule can define:
 *   - defaultTargetInternalTempF
 *   - toleranceF
 *   - safetyMinimumF (optional override)
 *   - labelMap overrides (optional)
 *
 * ids must be stable strings.
 */
const RULES = [
  // --------------------------- POULTRY ------------------------------------
  {
    id: "poultry:chicken:any:any",
    proteinCategory: "chicken",
    cutTag: "*",
    method: "*",
    defaultTargetInternalTempF: 165,
    toleranceF: 2,
    safetyMinimumF: 165,
    labels: { safe: 165, well: 170 },
    notes: "SSA baseline for chicken.",
  },
  {
    id: "poultry:turkey:any:any",
    proteinCategory: "turkey",
    cutTag: "*",
    method: "*",
    defaultTargetInternalTempF: 165,
    toleranceF: 2,
    safetyMinimumF: 165,
    labels: { safe: 165, well: 170 },
    notes: "SSA baseline for turkey.",
  },
  {
    id: "poultry:duck:breast:sear",
    proteinCategory: "duck",
    cutTag: "breast",
    method: "pan_sear",
    defaultTargetInternalTempF: 145,
    toleranceF: 3,
    safetyMinimumF: 135,
    labels: { medium_rare: 135, medium: 145, well: 165, safe: 165 },
    notes:
      "Duck breast can be served medium; SSA still allows safety enforcement.",
  },
  {
    id: "poultry:duck:any:any",
    proteinCategory: "duck",
    cutTag: "*",
    method: "*",
    defaultTargetInternalTempF: 165,
    toleranceF: 2,
    safetyMinimumF: 165,
    labels: { safe: 165, well: 170, medium: 145, medium_rare: 135 },
    notes: "SSA baseline for duck (non-breast).",
  },

  // --------------------------- BEEF / LAMB / GOAT --------------------------
  {
    id: "beef:steak:grill",
    proteinCategory: "beef",
    cutTag: "steak",
    method: "grill",
    defaultTargetInternalTempF: 135,
    toleranceF: 4,
    // safetyMinimumF derived from baseline unless overridden
    labels: {
      rare: 125,
      medium_rare: 135,
      medium: 145,
      medium_well: 150,
      well: 160,
    },
    notes: "Grilled steak baseline uses label map.",
  },
  {
    id: "beef:steak:roast",
    proteinCategory: "beef",
    cutTag: "steak",
    method: "roast",
    defaultTargetInternalTempF: 135,
    toleranceF: 4,
    labels: {
      rare: 125,
      medium_rare: 135,
      medium: 145,
      medium_well: 150,
      well: 160,
    },
    notes: "Roasted steak/tri-tip style baseline.",
  },
  {
    id: "beef:roast:any",
    proteinCategory: "beef",
    cutTag: "roast",
    method: "*",
    defaultTargetInternalTempF: 145,
    toleranceF: 4,
    labels: { medium_rare: 135, medium: 145, well: 160 },
    notes: "Beef roast baseline.",
  },
  {
    id: "lamb:chops:any",
    proteinCategory: "lamb",
    cutTag: "chops",
    method: "*",
    defaultTargetInternalTempF: 135,
    toleranceF: 4,
    labels: { rare: 125, medium_rare: 135, medium: 145, well: 160 },
    notes: "Lamb chops baseline.",
  },
  {
    id: "goat:roast:any",
    proteinCategory: "goat",
    cutTag: "roast",
    method: "*",
    defaultTargetInternalTempF: 160,
    toleranceF: 4,
    labels: { medium: 145, medium_well: 150, well: 160 },
    notes: "Goat roast is often cooked further for tenderness.",
  },

  // --------------------------- GROUND / SAUSAGE ----------------------------
  {
    id: "mammal:ground:any:any",
    proteinCategory: "*",
    cutTag: "ground",
    method: "*",
    defaultTargetInternalTempF: 160,
    toleranceF: 3,
    safetyMinimumF: 160,
    labels: { safe: 160, well: 165 },
    notes: "SSA baseline ground meats (mammal) safety floor.",
    appliesToProteins: [
      "beef",
      "lamb",
      "goat",
      "venison",
      "bison",
      "pork",
      "mixed",
      "unknown",
    ],
  },
  {
    id: "mammal:sausage:any:any",
    proteinCategory: "*",
    cutTag: "sausage",
    method: "*",
    defaultTargetInternalTempF: 160,
    toleranceF: 3,
    safetyMinimumF: 160,
    labels: { safe: 160, well: 165 },
    notes: "SSA baseline sausage safety floor.",
    appliesToProteins: [
      "beef",
      "lamb",
      "goat",
      "venison",
      "bison",
      "pork",
      "mixed",
      "unknown",
    ],
  },
  {
    id: "mammal:patty:any:any",
    proteinCategory: "*",
    cutTag: "patty",
    method: "*",
    defaultTargetInternalTempF: 160,
    toleranceF: 3,
    safetyMinimumF: 160,
    labels: { safe: 160, well: 165 },
    notes: "SSA baseline patties safety floor.",
    appliesToProteins: [
      "beef",
      "lamb",
      "goat",
      "venison",
      "bison",
      "pork",
      "mixed",
      "unknown",
    ],
  },

  // --------------------------- PORK ----------------------------------------
  {
    id: "pork:loin:any",
    proteinCategory: "pork",
    cutTag: "loin",
    method: "*",
    defaultTargetInternalTempF: 145,
    toleranceF: 3,
    safetyMinimumF: 145,
    labels: { medium: 145, well: 160, safe: 145 },
    notes: "Pork loin baseline.",
  },
  {
    id: "pork:shoulder:braise",
    proteinCategory: "pork",
    cutTag: "shoulder",
    method: "braise",
    defaultTargetInternalTempF: 195,
    toleranceF: 6,
    safetyMinimumF: 145,
    labels: { safe: 145, well: 160 },
    notes: "Shoulder braise often targets higher for tenderness/pull.",
  },

  // --------------------------- FISH / SEAFOOD ------------------------------
  {
    id: "fish:fillet:any",
    proteinCategory: "fish",
    cutTag: "fillet",
    method: "*",
    defaultTargetInternalTempF: 145,
    toleranceF: 3,
    safetyMinimumF: 145,
    labels: { opaque: 140, flakes: 145, safe: 145 },
    notes: "Fish fillet baseline.",
  },
  {
    id: "shellfish:any:any",
    proteinCategory: "shellfish",
    cutTag: "*",
    method: "*",
    defaultTargetInternalTempF: 145,
    toleranceF: 3,
    safetyMinimumF: 145,
    labels: { opaque: 145, safe: 145 },
    notes: "Shellfish baseline.",
  },

  // --------------------------- EGGS ----------------------------------------
  {
    id: "eggs:any:any",
    proteinCategory: "eggs",
    cutTag: "*",
    method: "*",
    defaultTargetInternalTempF: 160,
    toleranceF: 2,
    safetyMinimumF: 160,
    labels: { set: 160, safe: 160 },
    notes: "Eggs baseline for set/safe.",
  },

  // --------------------------- FALLBACK ------------------------------------
  {
    id: "fallback:any:any:any",
    proteinCategory: "unknown",
    cutTag: "*",
    method: "*",
    defaultTargetInternalTempF: 145,
    toleranceF: DEFAULT_TOLERANCE_F,
    safetyMinimumF: 145,
    labels: { medium: 145, well: 160, safe: 145 },
    notes: "Fallback baseline for unknown proteins.",
  },
];

/* -------------------------------------------------------------------------- */
/* Rule matching                                                               */
/* -------------------------------------------------------------------------- */

function ruleApplies(rule, proteinCategory, cutTag, method) {
  const p = PROTEIN_CATEGORIES.includes(proteinCategory)
    ? proteinCategory
    : "unknown";
  const c = CUT_TAGS.includes(cutTag) ? cutTag : "whole";
  const m = COOK_METHODS.includes(method) ? method : "*";

  // Protein match:
  const proteinOk =
    rule.proteinCategory === "*" ||
    rule.proteinCategory === p ||
    (Array.isArray(rule.appliesToProteins) &&
      rule.appliesToProteins.includes(p));

  if (!proteinOk) return false;

  // Cut match:
  const cutOk = rule.cutTag === "*" || rule.cutTag === c;
  if (!cutOk) return false;

  // Method match:
  const methodOk = rule.method === "*" || rule.method === m;
  if (!methodOk) return false;

  return true;
}

function ruleSpecificityScore(rule) {
  // Higher = more specific
  // Protein specificity: explicit protein > appliesToProteins list > wildcard
  let s = 0;
  if (
    rule.proteinCategory &&
    rule.proteinCategory !== "*" &&
    rule.proteinCategory !== "unknown"
  )
    s += 8;
  else if (
    Array.isArray(rule.appliesToProteins) &&
    rule.appliesToProteins.length
  )
    s += 6;
  else if (rule.proteinCategory === "unknown") s += 2;
  else s += 0;

  if (rule.cutTag && rule.cutTag !== "*") s += 4;
  if (rule.method && rule.method !== "*") s += 3;

  return s;
}

function getDonenessRule(query = {}) {
  const proteinCategory = query.proteinCategory || query.protein || "unknown";
  const cutTag = query.cutTag || query.cut || "whole";
  const method = query.method || "*";

  const candidates = RULES.filter((r) =>
    ruleApplies(r, proteinCategory, cutTag, method)
  );
  if (!candidates.length)
    return RULES.find((r) => r.id.startsWith("fallback:")) || null;

  candidates.sort((a, b) => ruleSpecificityScore(b) - ruleSpecificityScore(a));
  return candidates[0] || null;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

function resolveDonenessTargets(query = {}) {
  const proteinCategory = PROTEIN_CATEGORIES.includes(query.proteinCategory)
    ? query.proteinCategory
    : "unknown";
  const cutTag = CUT_TAGS.includes(query.cutTag) ? query.cutTag : "whole";
  const method = COOK_METHODS.includes(query.method) ? query.method : "*";

  const enforceSafetyMinimum =
    typeof query.enforceSafetyMinimum === "boolean"
      ? query.enforceSafetyMinimum
      : true;

  const rule = getDonenessRule({ proteinCategory, cutTag, method }) || null;

  // Determine baseline target/tolerance
  const ruleTarget = toTempF(rule?.defaultTargetInternalTempF ?? 145) ?? 145;
  const ruleTol =
    round1(clamp(rule?.toleranceF ?? DEFAULT_TOLERANCE_F, 0, 25)) ??
    DEFAULT_TOLERANCE_F;

  // Determine label map
  const baseLabelMap =
    LABEL_TEMP_MAP[proteinCategory] || LABEL_TEMP_MAP.unknown || {};
  const mergedLabelMap = {
    ...(isPlainObject(baseLabelMap) ? baseLabelMap : {}),
    ...(isPlainObject(rule?.labels) ? rule.labels : {}),
  };

  // Determine requested target
  const pref = parseDonenessPreference(query.donenessPreference);

  // Household override (explicit numeric)
  const ov = isPlainObject(query.householdOverrides)
    ? query.householdOverrides
    : null;
  const overrideTarget =
    ov?.targetInternalTempF != null
      ? toTempF(ov.targetInternalTempF)
      : undefined;
  const overrideTol =
    ov?.toleranceF != null ? round1(clamp(ov.toleranceF, 0, 25)) : undefined;

  let desiredTarget = ruleTarget;
  let desiredTol = ruleTol;
  let desiredLabel = null;
  let desiredSource = rule ? `rule:${rule.id}` : "rule:fallback";

  if (
    pref.type === "label" &&
    pref.label &&
    mergedLabelMap[pref.label] != null
  ) {
    desiredTarget = toTempF(mergedLabelMap[pref.label]) ?? desiredTarget;
    desiredLabel = pref.label;
    desiredSource = `label:${pref.label}`;
  } else if (pref.type === "target" && pref.tempF != null) {
    desiredTarget = toTempF(pref.tempF) ?? desiredTarget;
    desiredLabel = "target";
    desiredSource = "user:target";
  }

  if (overrideTarget != null) {
    desiredTarget = overrideTarget;
    desiredSource = "household_override:target";
  }
  if (overrideTol != null) desiredTol = overrideTol;

  // Safety enforcement
  const baselineSafety =
    toTempF(
      rule?.safetyMinimumF ?? safetyMinimumFor(proteinCategory, cutTag)
    ) ?? 145;

  let finalTarget = desiredTarget;
  let wasRaisedForSafety = false;
  if (enforceSafetyMinimum && finalTarget < baselineSafety) {
    finalTarget = baselineSafety;
    wasRaisedForSafety = true;
  }

  return {
    proteinCategory,
    cutTag,
    method,
    targetInternalTempF: round1(finalTarget),
    toleranceF: round1(desiredTol),
    safetyMinimumF: round1(baselineSafety),
    wasRaisedForSafety,
    donenessLabel: desiredLabel,
    source: desiredSource,
    ruleId: rule?.id || null,
    notes: rule?.notes || "",
    labelMap: mergedLabelMap,
  };
}

/**
 * ✅ Added for src/features/recipes/index.js compatibility.
 * Convenience alias used by callers that just want "the doneness target".
 * Returns the same resolution object as resolveDonenessTargets().
 */
function getDonenessTarget(query = {}) {
  return resolveDonenessTargets(query);
}

/* -------------------------------------------------------------------------- */
/* Listing / UI                                                                */
/* -------------------------------------------------------------------------- */

function listDonenessRules(filter = {}) {
  const proteinCategory = filter.proteinCategory;
  const cutTag = filter.cutTag;
  const method = filter.method;

  return RULES.filter((r) => {
    if (proteinCategory) {
      const p = PROTEIN_CATEGORIES.includes(proteinCategory)
        ? proteinCategory
        : "unknown";
      const proteinOk =
        r.proteinCategory === p ||
        r.proteinCategory === "*" ||
        (Array.isArray(r.appliesToProteins) && r.appliesToProteins.includes(p));
      if (!proteinOk) return false;
    }
    if (cutTag) {
      const c = CUT_TAGS.includes(cutTag) ? cutTag : "whole";
      if (!(r.cutTag === "*" || r.cutTag === c)) return false;
    }
    if (method) {
      const m = COOK_METHODS.includes(method) ? method : "*";
      if (!(r.method === "*" || r.method === m)) return false;
    }
    return true;
  }).map((r) => ({
    id: r.id,
    proteinCategory: r.proteinCategory,
    cutTag: r.cutTag,
    method: r.method,
    defaultTargetInternalTempF: r.defaultTargetInternalTempF,
    toleranceF: r.toleranceF,
    safetyMinimumF: r.safetyMinimumF,
    notes: r.notes || "",
    appliesToProteins: Array.isArray(r.appliesToProteins)
      ? [...r.appliesToProteins]
      : undefined,
  }));
}

function listDonenessLabels(proteinCategory) {
  const p = PROTEIN_CATEGORIES.includes(proteinCategory)
    ? proteinCategory
    : "unknown";
  const map = LABEL_TEMP_MAP[p] || {};
  const labels = Object.keys(map);
  labels.sort();
  return labels.map((label) => ({
    label,
    targetInternalTempF: map[label],
  }));
}

function explainDonenessResolution(query = {}) {
  const res = resolveDonenessTargets(query);
  const parts = [];

  parts.push(
    `Protein: ${res.proteinCategory}, cut: ${res.cutTag}, method: ${
      res.method === "*" ? "any" : res.method
    }.`
  );

  if (res.donenessLabel && res.donenessLabel !== "target") {
    parts.push(`Doneness label selected: "${res.donenessLabel}".`);
  } else if (
    safeLower(query.donenessPreference).startsWith("target") ||
    /^\d+/.test(String(query.donenessPreference || ""))
  ) {
    parts.push(
      `Numeric target requested: ${toTempF(query.donenessPreference) ?? "?"}°F.`
    );
  }

  parts.push(
    `Resolved target: ${res.targetInternalTempF}°F (±${res.toleranceF}°F).`
  );
  parts.push(
    `Safety minimum: ${res.safetyMinimumF}°F${
      res.wasRaisedForSafety ? " (target raised to meet safety minimum)." : "."
    }`
  );

  if (res.ruleId) parts.push(`Rule used: ${res.ruleId}.`);
  if (res.source) parts.push(`Source: ${res.source}.`);
  if (res.notes) parts.push(`Notes: ${res.notes}`);

  return parts.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Catalog export                                                              */
/* -------------------------------------------------------------------------- */

const DonenessTargetsCatalog = {
  id: CATALOG_ID,
  version: CATALOG_VERSION,
  enums: {
    PROTEIN_CATEGORIES: [...PROTEIN_CATEGORIES],
    CUT_TAGS: [...CUT_TAGS],
    COOK_METHODS: [...COOK_METHODS],
    DONENESS_LABELS: [...DONENESS_LABELS],
  },
  defaults: {
    toleranceF: DEFAULT_TOLERANCE_F,
  },
  maps: {
    LABEL_TEMP_MAP: deepFreezeClone(LABEL_TEMP_MAP),
    SAFETY_MINIMUMS_F: deepFreezeClone(SAFETY_MINIMUMS_F),
  },
  rules: RULES.map((r) => ({
    ...r,
    labels: r.labels ? { ...r.labels } : undefined,
  })),
  getDonenessRule,
  resolveDonenessTargets,
  getDonenessTarget, // ✅ added
  listDonenessRules,
  listDonenessLabels,
  explainDonenessResolution,
};

function deepFreezeClone(obj) {
  const cloned = JSON.parse(JSON.stringify(obj || {}));
  return deepFreeze(cloned);
}

function deepFreeze(o) {
  if (!o || typeof o !== "object") return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === "object" && !Object.isFrozen(o[k])) {
      deepFreeze(o[k]);
    }
  }
  return o;
}

export {
  DonenessTargetsCatalog,
  // named exports for engines/tests
  CATALOG_ID,
  CATALOG_VERSION,
  PROTEIN_CATEGORIES,
  CUT_TAGS,
  COOK_METHODS,
  DONENESS_LABELS,
  LABEL_TEMP_MAP,
  SAFETY_MINIMUMS_F,
  safetyMinimumFor,
  parseDonenessPreference,
  getDonenessRule,
  resolveDonenessTargets,
  getDonenessTarget, // ✅ added
  listDonenessRules,
  listDonenessLabels,
  explainDonenessResolution,
};

export default DonenessTargetsCatalog;
