/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\engines\DonenessResolver.js
//
// SSA • DonenessResolver
// -----------------------------------------------------------------------------
// Purpose:
//   Resolve the *user* doneness target for:
//     - proteins (proteinCategory + cutTag + method)
//     - fats (rendered/crisp/soft, smoke-point constraints)
//     - starches (al dente / tender / mushy, set gels, etc.)
//
// Output is deterministic, explainable, and can optionally enforce safety floors
// (esp. poultry/pork). This module is designed to sit *between* user profiles
// (doneness.profile.schema.js) and DonenessTargets.catalog.js.
//
// Used by:
//   - RecipeAdapterService (pipeline)
//   - CookSetupModal (user review + overrides)
//   - CookPlan compiler (targets attached to steps)
//
// Dependencies:
//   - DonenessTargets.catalog.js (primary catalog of default targets & safety floors)
//
// -----------------------------------------------------------------------------

import DonenessTargetsCatalog from "@/features/recipes/catalogs/DonenessTargets.catalog";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const ENGINE_ID = "features/recipes/engines/DonenessResolver";
const ENGINE_VERSION = "1.0.0";

const DEFAULTS = Object.freeze({
  enforceSafetyMinimum: true,

  // if the resolver cannot find an exact target, it will fallback to broader
  // matches (protein-only, then generic) and mark needsUserReview.
  allowFallbacks: true,

  // ensure we don’t return nonsense temps
  minTempF: 70,
  maxTempF: 450,

  // soft constraints for non-proteins
  fatDefault: { label: "rendered", confidence: 0.65 },
  starchDefault: { label: "tender", confidence: 0.65 },

  // if user has no doneness profile at all, still return deterministic defaults
  defaultProteinPrefByCategory: {
    beef: "medium",
    lamb: "medium",
    goat: "medium",
    venison: "medium",
    bison: "medium",
    pork: "safe",
    chicken: "safe",
    turkey: "safe",
    duck: "safe",
    fish: "flakes",
    shellfish: "opaque",
    eggs: "set",
    unknown: "safe",
  },
});

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function safeString(s, max = 256, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function clamp(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function nowISO() {
  return new Date().toISOString();
}

function getCatalogEnums() {
  const enums = DonenessTargetsCatalog?.enums || {};
  return {
    PROTEIN_CATEGORIES: Array.isArray(enums.PROTEIN_CATEGORIES)
      ? enums.PROTEIN_CATEGORIES
      : [],
    CUT_TAGS: Array.isArray(enums.CUT_TAGS) ? enums.CUT_TAGS : [],
    METHODS: Array.isArray(enums.METHODS) ? enums.METHODS : [],
    DONENESS_LABELS: Array.isArray(enums.DONENESS_LABELS)
      ? enums.DONENESS_LABELS
      : [],
    FAT_DONENESS_LABELS: Array.isArray(enums.FAT_DONENESS_LABELS)
      ? enums.FAT_DONENESS_LABELS
      : [],
    STARCH_DONENESS_LABELS: Array.isArray(enums.STARCH_DONENESS_LABELS)
      ? enums.STARCH_DONENESS_LABELS
      : [],
  };
}

function normalizeProteinCategory(p) {
  const s = safeLower(p) || "unknown";
  const { PROTEIN_CATEGORIES } = getCatalogEnums();
  if (PROTEIN_CATEGORIES.length && !PROTEIN_CATEGORIES.includes(s))
    return "unknown";
  return s;
}

function normalizeCutTag(c) {
  const s = safeLower(c) || "whole";
  const { CUT_TAGS } = getCatalogEnums();
  if (CUT_TAGS.length && !CUT_TAGS.includes(s)) return "whole";
  return s;
}

function normalizeMethod(m) {
  const s = safeLower(m) || "bake";
  const { METHODS } = getCatalogEnums();
  if (METHODS.length && !METHODS.includes(s)) return s; // method list may be open-ended in your catalog
  return s;
}

function normalizeCategoryType(type) {
  const s = safeLower(type);
  if (s === "protein" || s === "proteins") return "protein";
  if (s === "fat" || s === "fats") return "fat";
  if (s === "starch" || s === "starches") return "starch";
  if (s === "protein+cut+method") return "protein";
  return s || "protein";
}

/* -------------------------------------------------------------------------- */
/* Doneness profile parsing                                                     */
/* -------------------------------------------------------------------------- */
/**
 * We accept multiple tolerant shapes for donenessProfile:
 *
 * Preferred (recommended):
 * {
 *   id: "doneness_profile_1",
 *   default: { proteinLabel: "medium", starchLabel: "tender", fatLabel: "rendered" },
 *   proteins: { beef: { defaultLabel: "medium_rare", cuts: { steak: { label: "medium" }}} },
 *   starches: { rice: { label: "tender" }, pasta: { label: "al_dente" } },
 *   fats: { bacon: { label: "crisp" }, tallow: { label: "melted" } },
 *   overrides: [
 *     { type:"protein", proteinCategory:"beef", cutTag:"steak", method:"grill", targetInternalTempF:135, toleranceF:5 }
 *   ]
 * }
 *
 * Legacy/tolerant:
 * - { preference: "medium" }
 * - { defaultLabel: "medium", targets: [...] }
 */

function profileDefaultProteinLabel(profile, proteinCategory) {
  const p = normalizeProteinCategory(proteinCategory);
  const prof = isPlainObject(profile) ? profile : {};

  // explicit per-protein object
  if (isPlainObject(prof.proteins) && isPlainObject(prof.proteins[p])) {
    const entry = prof.proteins[p];
    const lbl =
      safeString(
        entry.defaultLabel || entry.label || entry.preference,
        64,
        ""
      ) || safeString(entry?.default?.label, 64, "");
    if (lbl) return lbl;
  }

  // global default
  const globalDefault =
    safeString(prof?.default?.proteinLabel, 64, "") ||
    safeString(prof?.defaultLabel, 64, "") ||
    safeString(prof?.preference, 64, "");
  if (globalDefault) return globalDefault;

  // fallback by protein
  return (
    DEFAULTS.defaultProteinPrefByCategory[p] ||
    DEFAULTS.defaultProteinPrefByCategory.unknown
  );
}

function profileSpecificProteinLabel(profile, proteinCategory, cutTag, method) {
  const p = normalizeProteinCategory(proteinCategory);
  const c = normalizeCutTag(cutTag);
  const m = normalizeMethod(method);
  const prof = isPlainObject(profile) ? profile : {};

  // nested shapes:
  // proteins[beef].cuts[steak].methods[grill].label
  const byProtein = isPlainObject(prof.proteins) ? prof.proteins[p] : null;
  if (isPlainObject(byProtein)) {
    const byCut = isPlainObject(byProtein.cuts)
      ? byProtein.cuts[c] || byProtein.cuts["*"]
      : null;
    if (isPlainObject(byCut)) {
      const byMethod = isPlainObject(byCut.methods)
        ? byCut.methods[m] || byCut.methods["*"]
        : null;
      if (isPlainObject(byMethod)) {
        const lbl = safeString(byMethod.label || byMethod.preference, 64, "");
        if (lbl) return lbl;
      }
      const cutLbl = safeString(byCut.label || byCut.preference, 64, "");
      if (cutLbl) return cutLbl;
    }
    // protein-level label
    const pLbl = safeString(byProtein.label || byProtein.preference, 64, "");
    if (pLbl) return pLbl;
  }

  // array targets (legacy)
  if (Array.isArray(prof.targets)) {
    const rows = prof.targets.filter((t) => isPlainObject(t));
    const exact = rows.find(
      (t) =>
        normalizeCategoryType(t.type) === "protein" &&
        normalizeProteinCategory(t.proteinCategory) === p &&
        normalizeCutTag(t.cutTag || "*") === c &&
        normalizeMethod(t.method || "*") === m &&
        typeof t.preference === "string"
    );
    if (exact) return safeString(exact.preference, 64, "");
    const cutOnly = rows.find(
      (t) =>
        normalizeCategoryType(t.type) === "protein" &&
        normalizeProteinCategory(t.proteinCategory) === p &&
        normalizeCutTag(t.cutTag || "*") === c &&
        (safeLower(t.method || "*") === "*" || !t.method) &&
        typeof t.preference === "string"
    );
    if (cutOnly) return safeString(cutOnly.preference, 64, "");
    const proteinOnly = rows.find(
      (t) =>
        normalizeCategoryType(t.type) === "protein" &&
        normalizeProteinCategory(t.proteinCategory) === p &&
        (safeLower(t.cutTag || "*") === "*" || !t.cutTag) &&
        typeof t.preference === "string"
    );
    if (proteinOnly) return safeString(proteinOnly.preference, 64, "");
  }

  return "";
}

function profileProteinNumericOverride(
  profile,
  proteinCategory,
  cutTag,
  method
) {
  const p = normalizeProteinCategory(proteinCategory);
  const c = normalizeCutTag(cutTag);
  const m = normalizeMethod(method);
  const prof = isPlainObject(profile) ? profile : {};

  // recommended: overrides array
  const list = Array.isArray(prof.overrides)
    ? prof.overrides
    : Array.isArray(prof.targets)
    ? prof.targets
    : [];
  for (const row of list) {
    if (!isPlainObject(row)) continue;
    if (normalizeCategoryType(row.type) !== "protein") continue;
    if (normalizeProteinCategory(row.proteinCategory) !== p) continue;

    const rowCut = row.cutTag != null ? normalizeCutTag(row.cutTag) : "*";
    const rowMethod = row.method != null ? normalizeMethod(row.method) : "*";

    // match: exact or wildcard
    const cutMatch = rowCut === c || rowCut === "*" || rowCut === "any";
    const methodMatch =
      rowMethod === m || rowMethod === "*" || rowMethod === "any";

    if (!cutMatch || !methodMatch) continue;

    const targetInternalTempF =
      row.targetInternalTempF ?? row.targetF ?? row.tempF ?? undefined;
    const toleranceF = row.toleranceF ?? row.tolerance ?? undefined;

    if (targetInternalTempF == null && toleranceF == null) continue;

    return {
      targetInternalTempF:
        targetInternalTempF != null ? Number(targetInternalTempF) : undefined,
      toleranceF: toleranceF != null ? Number(toleranceF) : undefined,
      ruleId: safeString(
        row.ruleId || row.id || "profile_override",
        128,
        "profile_override"
      ),
    };
  }

  return null;
}

function profileFatLabel(profile, fatTypeOrTag) {
  const prof = isPlainObject(profile) ? profile : {};
  const key = safeLower(fatTypeOrTag || "") || "*";

  // explicit mapping
  if (isPlainObject(prof.fats)) {
    const row = prof.fats[key] || prof.fats["*"];
    if (isPlainObject(row)) {
      const lbl = safeString(row.label || row.preference, 64, "");
      if (lbl) return lbl;
    }
  }

  // global default
  const d = safeString(prof?.default?.fatLabel, 64, "");
  if (d) return d;

  return DEFAULTS.fatDefault.label;
}

function profileStarchLabel(profile, starchTypeOrTag) {
  const prof = isPlainObject(profile) ? profile : {};
  const key = safeLower(starchTypeOrTag || "") || "*";

  if (isPlainObject(prof.starches)) {
    const row = prof.starches[key] || prof.starches["*"];
    if (isPlainObject(row)) {
      const lbl = safeString(row.label || row.preference, 64, "");
      if (lbl) return lbl;
    }
  }

  const d = safeString(prof?.default?.starchLabel, 64, "");
  if (d) return d;

  return DEFAULTS.starchDefault.label;
}

/* -------------------------------------------------------------------------- */
/* Resolution: protein                                                         */
/* -------------------------------------------------------------------------- */

function resolveProtein({
  proteinCategory,
  cutTag,
  method,
  donenessProfile,
  options,
}) {
  const p = normalizeProteinCategory(proteinCategory);
  const c = normalizeCutTag(cutTag);
  const m = normalizeMethod(method);

  const opts = normalizeOptions(options);

  const out = {
    ok: true,
    kind: "protein",
    engine: { id: ENGINE_ID, version: ENGINE_VERSION },
    at: nowISO(),
    proteinCategory: p,
    cutTag: c,
    method: m,

    // user preference label (e.g., medium_rare, safe, flakes)
    preferenceLabel: null,

    // numeric target (°F) if catalog supports it
    targetInternalTempF: null,
    toleranceF: null,
    safetyMinimumF: null,
    wasRaisedForSafety: false,

    // explainability
    source: "profile_or_default",
    ruleId: null,
    needsUserReview: false,
    flags: [],
    notes: [],
    warnings: [],
  };

  // 1) Determine label preference (profile specific -> protein default -> fallback)
  const specific = profileSpecificProteinLabel(donenessProfile, p, c, m);
  const defLbl = profileDefaultProteinLabel(donenessProfile, p);
  const preferenceLabel =
    specific || defLbl || DEFAULTS.defaultProteinPrefByCategory[p] || "safe";
  out.preferenceLabel = preferenceLabel;

  // 2) Numeric overrides from profile (explicit temp)
  const override = profileProteinNumericOverride(donenessProfile, p, c, m);
  if (override && override.targetInternalTempF != null) {
    out.targetInternalTempF = clamp(
      override.targetInternalTempF,
      DEFAULTS.minTempF,
      DEFAULTS.maxTempF,
      null
    );
    out.toleranceF =
      override.toleranceF != null ? clamp(override.toleranceF, 0, 50, 5) : null;
    out.source = "profile_override";
    out.ruleId = override.ruleId || "profile_override";
  }

  // 3) If no numeric override, ask catalog for numeric target given preference label
  if (out.targetInternalTempF == null) {
    const res = DonenessTargetsCatalog.resolveDonenessTargets({
      proteinCategory: p,
      cutTag: c,
      method: m,
      donenessPreference: preferenceLabel,
      householdOverrides: null, // profile overrides handled here
      enforceSafetyMinimum: opts.enforceSafetyMinimum,
    });

    out.targetInternalTempF =
      res?.targetInternalTempF != null
        ? clamp(
            res.targetInternalTempF,
            DEFAULTS.minTempF,
            DEFAULTS.maxTempF,
            null
          )
        : null;
    out.toleranceF =
      res?.toleranceF != null ? clamp(res.toleranceF, 0, 50, 5) : null;
    out.safetyMinimumF =
      res?.safetyMinimumF != null
        ? clamp(res.safetyMinimumF, DEFAULTS.minTempF, DEFAULTS.maxTempF, null)
        : null;
    out.wasRaisedForSafety = !!res?.wasRaisedForSafety;
    out.source = res?.source || "catalog";
    out.ruleId = res?.ruleId || null;

    if (out.wasRaisedForSafety) {
      out.flags.push("unsafe_target_was_raised");
      out.warnings.push({
        code: "unsafe_target_was_raised",
        message: `Requested "${preferenceLabel}" was below safety minimum; target raised to ${out.targetInternalTempF}°F.`,
      });
    }
  }

  // 4) Validate / mark review when missing numeric target
  if (out.targetInternalTempF == null) {
    out.needsUserReview = true;
    out.flags.push("missing_numeric_target");
    out.warnings.push({
      code: "missing_numeric_target",
      message:
        "No numeric internal temperature target could be resolved; use doneness cues or set a custom target.",
    });
  }

  // 5) If enforceSafetyMinimum and we have safety min, ensure floor
  if (
    opts.enforceSafetyMinimum &&
    out.targetInternalTempF != null &&
    out.safetyMinimumF != null
  ) {
    if (out.targetInternalTempF < out.safetyMinimumF) {
      out.targetInternalTempF = out.safetyMinimumF;
      out.wasRaisedForSafety = true;
      out.needsUserReview = true;
      out.flags = uniqStrings([
        ...out.flags,
        "unsafe_target_was_raised",
        "needs_user_review",
      ]);
      out.warnings.push({
        code: "safety_floor_enforced",
        message: `Safety floor enforced: target raised to ${out.safetyMinimumF}°F.`,
      });
    }
  }

  // 6) Confidence heuristic
  out.confidence = clamp01(
    out.source === "profile_override"
      ? 0.9
      : out.source === "catalog"
      ? 0.85
      : 0.7,
    0.7
  );

  return out;
}

/* -------------------------------------------------------------------------- */
/* Resolution: fat                                                             */
/* -------------------------------------------------------------------------- */
/**
 * Fats usually don’t have an “internal temp” target like proteins.
 * We resolve a doneness label + optional guidance temps for rendering/crisping,
 * and guard against smoke-point issues if the user indicates an oil/fat type.
 *
 * Inputs:
 *  - fatTag: e.g. "bacon", "tallow", "olive_oil", "butter"
 *  - method: e.g. "pan_sear", "bake", "render"
 */
function resolveFat({ fatTag, method, donenessProfile, options }) {
  const opts = normalizeOptions(options);
  const tag = safeLower(fatTag) || "fat";
  const m = normalizeMethod(method);

  const out = {
    ok: true,
    kind: "fat",
    engine: { id: ENGINE_ID, version: ENGINE_VERSION },
    at: nowISO(),
    fatTag: tag,
    method: m,

    preferenceLabel: null, // e.g. "crisp", "rendered", "soft"
    guidance: {
      // Optional guidance temps for technique (not safety floors)
      panTempRangeF: null,
      ovenTempRangeF: null,
      notes: [],
    },

    source: "profile_or_default",
    ruleId: null,
    needsUserReview: false,
    flags: [],
    warnings: [],
    confidence: 0.65,
  };

  const label = profileFatLabel(donenessProfile, tag);
  out.preferenceLabel = label;

  // Basic deterministic guidance (no web, no brand claims)
  // These are *technique* ranges, not safety internal temps.
  if (label.includes("crisp") || label.includes("crispy")) {
    if (["bake", "roast", "broil"].includes(m))
      out.guidance.ovenTempRangeF = [375, 425];
    if (["pan_sear", "saute", "stir_fry"].includes(m))
      out.guidance.panTempRangeF = [325, 375];
    out.guidance.notes.push(
      "Aim for steady heat; render fat first, then crisp."
    );
  } else if (label.includes("render") || label.includes("melt")) {
    if (["bake", "roast"].includes(m)) out.guidance.ovenTempRangeF = [250, 325];
    if (["pan_sear", "saute"].includes(m))
      out.guidance.panTempRangeF = [225, 300];
    out.guidance.notes.push(
      "Lower heat renders more evenly and reduces burning."
    );
  } else {
    // soft/just melted
    out.guidance.panTempRangeF = [200, 275];
    out.guidance.notes.push("Use gentle heat to avoid browning/burning.");
  }

  // Smoke-point style warning (very conservative, non-authoritative)
  // If user tags indicate delicate fats, warn at high heat methods
  const delicate = [
    "butter",
    "extra_virgin_olive_oil",
    "olive_oil",
    "sesame_oil",
  ];
  const highHeatMethod = [
    "stir_fry",
    "pan_sear",
    "deep_fry",
    "grill",
    "broil",
  ].includes(m);
  if (highHeatMethod && delicate.includes(tag)) {
    out.warnings.push({
      code: "possible_smoke_point_issue",
      message: `Fat "${tag}" may smoke/burn at high heat with method "${m}". Consider a higher-heat fat or reduce heat.`,
    });
    out.flags.push("smoke_point_caution");
    out.needsUserReview = opts.allowFallbacks ? true : out.needsUserReview;
    out.confidence = 0.6;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Resolution: starch                                                          */
/* -------------------------------------------------------------------------- */
/**
 * Starches are typically resolved by a doneness label + optional boil/simmer
 * ranges, not internal temps.
 *
 * Inputs:
 *  - starchTag: e.g. "pasta", "rice", "potato", "bread", "cornbread", "naan"
 *  - method: e.g. "boil", "simmer", "bake", "steam"
 */
function resolveStarch({ starchTag, method, donenessProfile, options }) {
  const opts = normalizeOptions(options);
  const tag = safeLower(starchTag) || "starch";
  const m = normalizeMethod(method);

  const out = {
    ok: true,
    kind: "starch",
    engine: { id: ENGINE_ID, version: ENGINE_VERSION },
    at: nowISO(),
    starchTag: tag,
    method: m,

    preferenceLabel: null, // "al_dente", "tender", "soft", "mushy", "set"
    guidance: {
      notes: [],
      boilIntensity: null, // "rolling", "gentle", "covered_simmer"
      donenessCues: [],
    },

    source: "profile_or_default",
    ruleId: null,
    needsUserReview: false,
    flags: [],
    warnings: [],
    confidence: 0.65,
  };

  const label = profileStarchLabel(donenessProfile, tag);
  out.preferenceLabel = label;

  // Deterministic cues
  if (tag.includes("pasta")) {
    out.guidance.boilIntensity = "rolling";
    if (label.includes("al"))
      out.guidance.donenessCues.push(
        "Center shows slight firmness when bitten."
      );
    else if (label.includes("soft"))
      out.guidance.donenessCues.push("No firm center; fully tender.");
    else out.guidance.donenessCues.push("Tender with slight bite (default).");
    out.guidance.notes.push("Salt water well; stir early to prevent sticking.");
  } else if (tag.includes("rice")) {
    out.guidance.boilIntensity = "covered_simmer";
    if (label.includes("tender"))
      out.guidance.donenessCues.push(
        "Grains tender; water absorbed; rest 10 min covered."
      );
    if (label.includes("sticky"))
      out.guidance.donenessCues.push(
        "Use appropriate variety; avoid excessive rinsing."
      );
    out.guidance.notes.push("Keep lid on during simmer; fluff after resting.");
  } else if (tag.includes("potato")) {
    out.guidance.boilIntensity = "gentle";
    out.guidance.donenessCues.push("Knife slides in with little resistance.");
    out.guidance.notes.push("Start in cold water for even cooking (chunks).");
  } else if (
    tag.includes("bread") ||
    tag.includes("naan") ||
    tag.includes("cornbread")
  ) {
    out.guidance.donenessCues.push(
      "Set structure; no wet batter; surface browned."
    );
    out.guidance.notes.push("Bake times vary by pan/thickness; check early.");
  } else {
    out.guidance.donenessCues.push("Cook until texture matches preference.");
  }

  // Starch “safety” isn’t like meat; user review mainly when ambiguous
  if (!label) {
    out.needsUserReview = true;
    out.flags.push("missing_starch_label");
    out.warnings.push({
      code: "missing_starch_label",
      message: "No starch doneness label found; using default 'tender'.",
    });
    out.preferenceLabel = DEFAULTS.starchDefault.label;
  }

  // If method doesn't match typical, warn (still allowed)
  if (tag.includes("pasta") && !["boil", "simmer"].includes(m)) {
    out.flags.push("unusual_method_for_starch");
    out.warnings.push({
      code: "unusual_method_for_starch",
      message: `Method "${m}" is unusual for pasta; verify steps and doneness cues.`,
    });
    out.needsUserReview = opts.allowFallbacks ? true : out.needsUserReview;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

function normalizeOptions(options) {
  const o = isPlainObject(options) ? options : {};
  return {
    enforceSafetyMinimum:
      typeof o.enforceSafetyMinimum === "boolean"
        ? o.enforceSafetyMinimum
        : DEFAULTS.enforceSafetyMinimum,
    allowFallbacks:
      typeof o.allowFallbacks === "boolean"
        ? o.allowFallbacks
        : DEFAULTS.allowFallbacks,
  };
}

/**
 * Resolve doneness target for a category.
 *
 * Input (recommended):
 * {
 *   type: "protein" | "fat" | "starch",
 *   proteinCategory, cutTag, method,
 *   fatTag,
 *   starchTag,
 *   donenessProfile,
 *   options
 * }
 */
function resolveDonenessTarget(input = {}) {
  const type = normalizeCategoryType(input.type || "protein");
  const options = normalizeOptions(input.options);

  if (type === "fat") {
    return resolveFat({
      fatTag: input.fatTag || input.fatType || input.tag || "fat",
      method: input.method || "saute",
      donenessProfile: input.donenessProfile || null,
      options,
    });
  }

  if (type === "starch") {
    return resolveStarch({
      starchTag: input.starchTag || input.starchType || input.tag || "starch",
      method: input.method || "boil",
      donenessProfile: input.donenessProfile || null,
      options,
    });
  }

  // default: protein
  return resolveProtein({
    proteinCategory: input.proteinCategory || "unknown",
    cutTag: input.cutTag || "whole",
    method: input.method || "bake",
    donenessProfile: input.donenessProfile || null,
    options,
  });
}

/**
 * Convenience: resolve protein target from protein+cut+method.
 */
function resolveProteinTarget(input = {}) {
  return resolveProtein({
    proteinCategory: input.proteinCategory || "unknown",
    cutTag: input.cutTag || "whole",
    method: input.method || "bake",
    donenessProfile: input.donenessProfile || null,
    options: input.options || {},
  });
}

/**
 * Convenience: resolve fat target.
 */
function resolveFatTarget(input = {}) {
  return resolveFat({
    fatTag: input.fatTag || input.fatType || input.tag || "fat",
    method: input.method || "saute",
    donenessProfile: input.donenessProfile || null,
    options: input.options || {},
  });
}

/**
 * Convenience: resolve starch target.
 */
function resolveStarchTarget(input = {}) {
  return resolveStarch({
    starchTag: input.starchTag || input.starchType || input.tag || "starch",
    method: input.method || "boil",
    donenessProfile: input.donenessProfile || null,
    options: input.options || {},
  });
}

/**
 * Build a CookPlan-friendly "targets" array entry from a resolved target.
 * (Does not mutate plan; just returns a normalized target object.)
 */
function toCookPlanTarget(resolved, opts = {}) {
  const r = isPlainObject(resolved) ? resolved : {};
  const id =
    safeString(opts.id, 128, "") ||
    `target_${Math.random().toString(16).slice(2)}_${Date.now()}`;

  if (r.kind === "protein") {
    const value =
      r.targetInternalTempF != null ? Number(r.targetInternalTempF) : null;
    return {
      id,
      kind: value != null ? "internal_temp_f" : "doneness_label",
      label: value != null ? "Internal temperature" : "Doneness",
      value:
        value != null ? value : safeString(r.preferenceLabel, 64, "target"),
      unit: value != null ? "F" : null,
      severity: r.wasRaisedForSafety
        ? "warn"
        : r.needsUserReview
        ? "warn"
        : "info",
      source: r.source || ENGINE_ID,
      notes: buildNotesString(r),
      meta: {
        resolver: { id: ENGINE_ID, version: ENGINE_VERSION },
        proteinCategory: r.proteinCategory,
        cutTag: r.cutTag,
        method: r.method,
        preferenceLabel: r.preferenceLabel,
        toleranceF: r.toleranceF ?? null,
        safetyMinimumF: r.safetyMinimumF ?? null,
        ruleId: r.ruleId ?? null,
        flags: uniqStrings(r.flags),
      },
    };
  }

  if (r.kind === "fat") {
    return {
      id,
      kind: "fat_doneness_label",
      label: "Fat doneness",
      value: safeString(r.preferenceLabel, 64, DEFAULTS.fatDefault.label),
      unit: null,
      severity: r.needsUserReview ? "warn" : "info",
      source: r.source || ENGINE_ID,
      notes: buildNotesString(r),
      meta: {
        resolver: { id: ENGINE_ID, version: ENGINE_VERSION },
        fatTag: r.fatTag,
        method: r.method,
        guidance: r.guidance || null,
        flags: uniqStrings(r.flags),
      },
    };
  }

  if (r.kind === "starch") {
    return {
      id,
      kind: "starch_doneness_label",
      label: "Starch doneness",
      value: safeString(r.preferenceLabel, 64, DEFAULTS.starchDefault.label),
      unit: null,
      severity: r.needsUserReview ? "warn" : "info",
      source: r.source || ENGINE_ID,
      notes: buildNotesString(r),
      meta: {
        resolver: { id: ENGINE_ID, version: ENGINE_VERSION },
        starchTag: r.starchTag,
        method: r.method,
        guidance: r.guidance || null,
        flags: uniqStrings(r.flags),
      },
    };
  }

  // fallback generic
  return {
    id,
    kind: "doneness_label",
    label: "Doneness",
    value: safeString(r.preferenceLabel, 64, "target"),
    unit: null,
    severity: r.needsUserReview ? "warn" : "info",
    source: r.source || ENGINE_ID,
    notes: buildNotesString(r),
    meta: { resolver: { id: ENGINE_ID, version: ENGINE_VERSION } },
  };
}

function buildNotesString(r) {
  const notes = [];
  if (Array.isArray(r.notes))
    notes.push(...r.notes.map((x) => safeString(x, 400, "")).filter(Boolean));
  if (Array.isArray(r.warnings) && r.warnings.length) {
    notes.push(
      ...r.warnings
        .slice(0, 4)
        .map((w) => safeString(w.message || w.code, 400, ""))
        .filter(Boolean)
    );
  }
  return notes.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Export bundle                                                               */
/* -------------------------------------------------------------------------- */

const DonenessResolver = Object.freeze({
  engine: { id: ENGINE_ID, version: ENGINE_VERSION },
  resolveDonenessTarget,
  resolveProteinTarget,
  resolveFatTarget,
  resolveStarchTarget,
  toCookPlanTarget,
});

export {
  DonenessResolver,
  ENGINE_ID,
  ENGINE_VERSION,
  resolveDonenessTarget,
  resolveProteinTarget,
  resolveFatTarget,
  resolveStarchTarget,
  toCookPlanTarget,
};

export default DonenessResolver;
