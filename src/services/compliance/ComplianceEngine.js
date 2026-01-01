// src/services/compliance/ComplianceEngine.js
//
// ComplianceEngine
// ----------------
// “Does this comply with this household?”
//
// Pipeline role:
//   imports → intelligence (classification + compliance) → StepGraph → automation → (optional) Hub export
//
// This module takes:
//   - a household profile (Torah/diet/health/cleaning/garden/animal constraints)
//   - classified items from DomainClassifier (with tag flags),
// and returns a normalized compliance result via buildComplianceMeta(...) that
// downstream code can attach to sessionMeta.compliance:
//
//   sessionMeta: {
//     stepGraphReady: true,
//     compliance: await evaluateCompliance({ householdId, domain, items })
//   }
//
// It is domain-agnostic glue: cooking, cleaning, garden, animals, preservation,
// and storehouse all call into this one engine so compliance logic lives in a
// single place, not scattered across domain pages.
//
// NOTE: This module does *not* mutate inventory or sessions, so it does NOT
// export to the Hub directly. The code that saves artifacts/sessions is
// responsible for optional Hub export.

/* ---------------------------------- Imports ---------------------------------- */

import { COMPLIANCE_STATUS, buildComplianceMeta } from "./ComplianceContract";
import { getHouseholdProfile } from "../household/HouseholdProfile";
import { emitEvent } from "../eventBus";

/* --------------------------------- Constants --------------------------------- */

const MODULE_SOURCE = "services.compliance.ComplianceEngine";

const SUPPORTED_DOMAINS = Object.freeze([
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "preservation",
  "storehouse",
]);

/* --------------------------------- Typedefs ---------------------------------- */
/**
 * @typedef {import("./ComplianceContract").ComplianceMeta} ComplianceMeta
 */

/* ----------------------------- Public Entry Point ---------------------------- */

/**
 * Evaluate compliance of classified items against a household's constraints.
 *
 * @param {Object} params
 * @param {string|null|undefined} params.householdId
 * @param {string} params.domain - e.g. "cooking", "cleaning", "garden", "animals"
 * @param {Array<{
 *   id: string,
 *   name: string,
 *   canonicalName?: string,
 *   domain?: string,
 *   tags?: Record<string, any>,
 *   meta?: Record<string, any>
 * }>} params.items - Classified items from DomainClassifier
 *
 * @returns {Promise<ComplianceMeta>} compliance metadata
 */
export async function evaluateCompliance({ householdId, domain, items }) {
  const ts = new Date().toISOString();

  const normalizedDomain = typeof domain === "string" ? domain.trim() : "";
  const safeItems = Array.isArray(items) ? items : [];

  if (!normalizedDomain) {
    emitSafe({
      type: "compliance.evaluation.failed",
      ts,
      source: MODULE_SOURCE,
      data: {
        householdId: householdId || "default",
        domain,
        reason: "Missing domain",
      },
    });

    // Default to "needsReview" when we can't evaluate cleanly.
    return buildComplianceMeta({
      status: COMPLIANCE_STATUS.NEEDS_REVIEW,
      hardViolations: [],
      softConflicts: [
        {
          code: "DOMAIN_MISSING",
          severity: "soft",
          message: "Domain not provided; manual review required.",
          meta: {},
        },
      ],
      allergenRisks: [],
    });
  }

  if (!SUPPORTED_DOMAINS.includes(normalizedDomain)) {
    // Forward-compatible: still run heuristics, but warn.
    if (typeof console !== "undefined") {
      console.warn(
        `[ComplianceEngine] evaluateCompliance called with unsupported domain "${normalizedDomain}". Proceeding anyway.`
      );
    }
  }

  // Always get a normalized profile (defaults filled in).
  const profile = await getHouseholdProfile(householdId);

  const { hardViolations, softConflicts, allergenRisks } = computeCompliance(
    profile,
    normalizedDomain,
    safeItems
  );

  // Determine status from violations/conflicts.
  let status = COMPLIANCE_STATUS.COMPLIANT;
  if (hardViolations.length > 0) {
    status = COMPLIANCE_STATUS.BLOCKED;
  } else if (softConflicts.length > 0 || allergenRisks.length > 0) {
    status = COMPLIANCE_STATUS.NEEDS_REVIEW;
  }

  const meta = buildComplianceMeta({
    status,
    hardViolations,
    softConflicts,
    allergenRisks,
  });

  emitSafe({
    type: "compliance.evaluation.completed",
    ts: meta.scannedAt,
    source: MODULE_SOURCE,
    data: {
      householdId: profile.householdId,
      domain: normalizedDomain,
      status: meta.status,
      hardViolationCount: meta.hardViolations.length,
      softConflictCount: meta.softConflicts.length,
      allergenRiskCount: meta.allergenRisks.length,
    },
  });

  return meta;
}

/* ----------------------------- Core Computation ------------------------------ */

/**
 * Core compliance computation: pure function (no I/O).
 *
 * @param {import("../household/HouseholdProfile").HouseholdProfile} profile
 * @param {string} domain
 * @param {Array<any>} items
 */
function computeCompliance(profile, domain, items) {
  /** @type {any[]} */
  const hardViolations = [];
  /** @type {any[]} */
  const softConflicts = [];
  /** @type {any[]} */
  const allergenRisks = [];

  const p = profile || {};
  const bansHard = lowerArray(p.hardNoIngredients);
  const bansSoft = lowerArray(p.softAvoidIngredients);
  const allergens = lowerArray(p.allergens);
  const cleaningBans = lowerArray(p.cleaningBans);
  const gardenBans = lowerArray(p.gardenBans);
  const animalBans = lowerArray(p.animalCareBans);
  const macro = p.macroHealthGoals || {};

  for (const item of items) {
    if (!item) continue;

    const name = (item.name || item.canonicalName || "").toString();
    if (!name.trim()) continue;

    const nameLower = name.toLowerCase();
    const tags = item.tags || {};

    // 1) Hard Torah/diet bans (cooking/preservation/storehouse)
    if (
      domain === "cooking" ||
      domain === "preservation" ||
      domain === "storehouse"
    ) {
      evaluateHardTorahDiet(
        bansHard,
        name,
        nameLower,
        tags,
        domain,
        item,
        hardViolations
      );
      evaluateSoftDiet(
        bansSoft,
        name,
        nameLower,
        tags,
        domain,
        item,
        softConflicts
      );
      evaluateAllergens(
        allergens,
        name,
        nameLower,
        tags,
        domain,
        item,
        allergenRisks
      );
      evaluateMacroHealthGoals(
        macro,
        name,
        nameLower,
        tags,
        domain,
        item,
        softConflicts
      );
    }

    // 2) Cleaning bans
    if (domain === "cleaning") {
      evaluateCleaningBans(
        cleaningBans,
        name,
        nameLower,
        tags,
        domain,
        item,
        hardViolations,
        softConflicts
      );
    }

    // 3) Garden bans
    if (domain === "garden") {
      evaluateGardenBans(
        gardenBans,
        name,
        nameLower,
        tags,
        domain,
        item,
        hardViolations,
        softConflicts
      );
    }

    // 4) Animal care bans
    if (domain === "animals") {
      evaluateAnimalCareBans(
        animalBans,
        name,
        nameLower,
        tags,
        domain,
        item,
        hardViolations,
        softConflicts
      );
    }

    // 5) Cross-domain: generic Torah restricted flag
    if (hasKeyword(bansHard, ["unclean", "non-kosher", "torah restricted"])) {
      if (tags.isTorahRestricted || tags.isUncleanBiblical) {
        hardViolations.push({
          code: "TORAH_RESTRICTED",
          severity: "hard",
          message: `Item "${name}" is marked as Torah-restricted and conflicts with household hardNoIngredients.`,
          meta: {
            domain,
            itemId: item.id,
            itemName: name,
          },
        });
      }
    }
  }

  return { hardViolations, softConflicts, allergenRisks };
}

/* ------------------------ Domain-specific Evaluation ------------------------- */

function evaluateHardTorahDiet(
  bansHard,
  name,
  nameLower,
  tags,
  domain,
  item,
  hardViolations
) {
  // If household has explicit pork ban and item looks like pork
  if (
    hasKeyword(bansHard, ["pork"]) &&
    (tags.isPork || nameLower.includes("pork"))
  ) {
    hardViolations.push({
      code: "PORK",
      severity: "hard",
      message: `Pork item "${name}" conflicts with household hardNoIngredients.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Shellfish ban
  if (
    hasKeyword(bansHard, ["shellfish", "seafood"]) &&
    (tags.isShellfish ||
      /shrimp|prawn|lobster|crab|oyster|clam|mussel|scallop/.test(nameLower))
  ) {
    hardViolations.push({
      code: "SHELLFISH",
      severity: "hard",
      message: `Shellfish item "${name}" conflicts with household hardNoIngredients.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Generic unclean / blood, etc.
  if (
    hasKeyword(bansHard, ["unclean", "unclean meats", "non-kosher"]) &&
    (tags.isUncleanBiblical || tags.isTorahRestricted)
  ) {
    hardViolations.push({
      code: "UNCLEAN_MEAT",
      severity: "hard",
      message: `Item "${name}" is marked as biblically unclean and conflicts with household hardNoIngredients.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  if (hasKeyword(bansHard, ["blood"]) && /\bblood\b/.test(nameLower)) {
    hardViolations.push({
      code: "BLOOD",
      severity: "hard",
      message: `Item "${name}" appears to contain blood and conflicts with household hardNoIngredients.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }
}

function evaluateSoftDiet(
  bansSoft,
  name,
  nameLower,
  tags,
  domain,
  item,
  softConflicts
) {
  // Seed oils
  if (
    hasKeyword(bansSoft, ["seed oil", "seed oils", "industrial seed oils"]) &&
    (tags.isSeedOil ||
      /\b(canola|soybean|corn|cottonseed|sunflower|safflower|grapeseed|rice bran)\b/.test(
        nameLower
      ))
  ) {
    softConflicts.push({
      code: "SEED_OIL",
      severity: "soft",
      message: `Item "${name}" uses seed oils which household prefers to avoid.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Ultra-processed foods
  if (
    hasKeyword(bansSoft, [
      "ultra-processed",
      "ultra processed",
      "processed foods",
    ]) &&
    (tags.isUltraProcessed ||
      /\b(margarine|instant noodle|soda|candy)\b/.test(nameLower))
  ) {
    softConflicts.push({
      code: "ULTRA_PROCESSED",
      severity: "soft",
      message: `Item "${name}" appears ultra-processed; household prefers to avoid.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }
}

function evaluateAllergens(
  allergens,
  name,
  nameLower,
  tags,
  domain,
  item,
  allergenRisks
) {
  // Map household allergen keywords to tag checks.
  const pushAllergen = (code, condition, label) => {
    if (!condition) return;
    if (!hasKeyword(allergens, [label, code.toLowerCase()])) return;

    allergenRisks.push({
      code,
      severity: "allergen",
      message: `Item "${name}" may contain ${label} and conflicts with household allergen list.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  };

  pushAllergen("ALLERGEN_DAIRY", tags.isAllergenDairy || tags.isDairy, "dairy");
  pushAllergen("ALLERGEN_NUT", tags.isAllergenNut, "nuts");
  pushAllergen("ALLERGEN_GLUTEN", tags.isAllergenGluten, "gluten");
  pushAllergen("ALLERGEN_SOY", tags.isAllergenSoy, "soy");

  // Egg
  pushAllergen("ALLERGEN_EGG", tags.isEgg || /\begg\b/.test(nameLower), "egg");

  // Shellfish as allergen
  pushAllergen(
    "ALLERGEN_SHELLFISH",
    tags.isShellfish ||
      /\b(shrimp|prawn|lobster|crab|oyster|clam|mussel|scallop)\b/.test(
        nameLower
      ),
    "shellfish"
  );
}

function evaluateMacroHealthGoals(
  macro,
  name,
  nameLower,
  tags,
  domain,
  item,
  softConflicts
) {
  if (!macro || typeof macro !== "object") return;

  const pushConflict = (code, condition, message) => {
    if (!condition) return;
    softConflicts.push({
      code,
      severity: "soft",
      message: message.replace("{NAME}", name),
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  };

  // Low sodium goals: flag overtly salty items
  if (macro.lowSodium) {
    pushConflict(
      "LOW_SODIUM_CONFLICT",
      /\b(salt|soy sauce|brine|salty)\b/.test(nameLower),
      `Item "{NAME}" appears high in sodium; household prefers low-sodium options.`
    );
  }

  // Low sugar goals
  if (macro.lowSugar) {
    pushConflict(
      "LOW_SUGAR_CONFLICT",
      /\b(sugar|syrup|sweetened|corn syrup|hfcs|candy|soda)\b/.test(nameLower),
      `Item "{NAME}" appears high in sugar; household prefers low-sugar options.`
    );
  }

  // High protein goals: flag obviously low-protein, ultra-processed carbs as soft conflict
  if (macro.highProtein) {
    pushConflict(
      "HIGH_PROTEIN_WEAK",
      tags.isUltraProcessed &&
        /\b(chip|cracker|cookie|white bread|pasta|cereal)\b/.test(nameLower),
      `Item "{NAME}" is ultra-processed and low-protein; may not align with high-protein goals.`
    );
  }

  // Weight-loss goals: flag ultra-processed snacks & sweets
  if (macro.weightLoss) {
    pushConflict(
      "WEIGHT_LOSS_CONFLICT",
      tags.isUltraProcessed &&
        /\b(snack|chip|cookie|candy|ice cream|fried)\b/.test(nameLower),
      `Item "{NAME}" is ultra-processed and may conflict with weight-loss goals.`
    );
  }
}

/* --------------------------- Cleaning / Garden / Animals --------------------- */

function evaluateCleaningBans(
  cleaningBans,
  name,
  nameLower,
  tags,
  domain,
  item,
  hardViolations,
  softConflicts
) {
  // No bleach
  if (hasKeyword(cleaningBans, ["bleach", "no bleach"]) && tags.isBleach) {
    hardViolations.push({
      code: "BLEACH_BANNED",
      severity: "hard",
      message: `Bleach cleaner "${name}" conflicts with household cleaningBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Fragrance-free household
  if (
    hasKeyword(cleaningBans, [
      "fragrance-free",
      "no fragrance",
      "fragrance free",
    ]) &&
    (tags.isFragranceHeavy || /\b(fragrance|parfum|scented)\b/.test(nameLower))
  ) {
    softConflicts.push({
      code: "FRAGRANCE_CONFLICT",
      severity: "soft",
      message: `Fragrance-heavy cleaner "${name}" may conflict with household fragrance-free preference.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // No harsh synthetic chemicals
  if (
    hasKeyword(cleaningBans, [
      "synthetic",
      "harsh chemicals",
      "no harsh cleaners",
    ]) &&
    tags.isCleaningChemical
  ) {
    softConflicts.push({
      code: "HARSH_CHEMICAL",
      severity: "soft",
      message: `Cleaner "${name}" is a synthetic chemical; household prefers gentler options.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }
}

function evaluateGardenBans(
  gardenBans,
  name,
  nameLower,
  tags,
  domain,
  item,
  hardViolations,
  softConflicts
) {
  // Herbicides
  if (
    hasKeyword(gardenBans, [
      "herbicide",
      "no herbicides",
      "glyphosate",
      "roundup",
    ]) &&
    tags.isHerbicide
  ) {
    hardViolations.push({
      code: "HERBICIDE_BANNED",
      severity: "hard",
      message: `Herbicide "${name}" conflicts with household gardenBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Pesticides
  if (
    hasKeyword(gardenBans, [
      "pesticide",
      "no pesticides",
      "insecticide",
      "fungicide",
    ]) &&
    tags.isPesticide
  ) {
    hardViolations.push({
      code: "PESTICIDE_BANNED",
      severity: "hard",
      message: `Pesticide "${name}" conflicts with household gardenBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Synthetic fertilizers as soft conflict
  if (
    hasKeyword(gardenBans, [
      "synthetic fertilizer",
      "no synthetic fertilizer",
    ]) &&
    tags.isFertilizerSynthetic
  ) {
    softConflicts.push({
      code: "SYNTHETIC_FERTILIZER",
      severity: "soft",
      message: `Synthetic fertilizer "${name}" may conflict with household gardenBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Invasive species risk
  if (
    hasKeyword(gardenBans, ["invasive", "no invasives"]) &&
    (tags.isInvasiveRisk ||
      /\b(kudzu|english ivy|japanese knotweed|bamboo)\b/.test(nameLower))
  ) {
    hardViolations.push({
      code: "INVASIVE_RISK",
      severity: "hard",
      message: `Plant/product "${name}" poses an invasive risk and conflicts with household gardenBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }
}

function evaluateAnimalCareBans(
  animalBans,
  name,
  nameLower,
  tags,
  domain,
  item,
  hardViolations,
  softConflicts
) {
  // Routine antibiotics
  if (
    hasKeyword(animalBans, [
      "antibiotic",
      "no antibiotics",
      "routine antibiotics",
    ]) &&
    tags.isDrugAntibiotic
  ) {
    hardViolations.push({
      code: "ANTIBIOTIC_BANNED",
      severity: "hard",
      message: `Antibiotic product "${name}" conflicts with household animalCareBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Hormones
  if (
    hasKeyword(animalBans, ["hormone", "growth promoter", "no hormones"]) &&
    tags.isDrugHormone
  ) {
    hardViolations.push({
      code: "HORMONE_BANNED",
      severity: "hard",
      message: `Hormone/growth-promoter "${name}" conflicts with household animalCareBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }

  // Unclean feeds
  if (
    hasKeyword(animalBans, [
      "unclean feed",
      "no unclean feed",
      "no blood meal",
    ]) &&
    (tags.isUncleanBiblical ||
      /\b(blood meal|meat and bone meal|pork by-product)\b/.test(nameLower))
  ) {
    hardViolations.push({
      code: "UNCLEAN_FEED",
      severity: "hard",
      message: `Feed "${name}" appears unclean (blood/by-product) and conflicts with household animalCareBans.`,
      meta: {
        domain,
        itemId: item.id,
        itemName: name,
      },
    });
  }
}

/* ------------------------------- Helpers ------------------------------------ */

function lowerArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter(Boolean);
}

/**
 * Return true if any of the keywords appear in the list.
 *
 * @param {string[]} listLower
 * @param {string[]} keywords
 */
function hasKeyword(listLower, keywords) {
  if (!listLower.length || !keywords.length) return false;

  const set = new Set(listLower);
  for (const raw of keywords) {
    const k = raw.toLowerCase();
    if (set.has(k)) return true;
    // Also check substring matches for fuzzy cases
    for (const item of listLower) {
      if (item.includes(k)) return true;
    }
  }
  return false;
}

/* --------------------------------- Events ----------------------------------- */

/**
 * Safe wrapper for eventBus emit.
 *
 * @param {{ type: string, ts: string, source: string, data: any }} payload
 */
function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;

  try {
    emitEvent(payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[ComplianceEngine] Failed to emit event", err);
    }
  }
}
