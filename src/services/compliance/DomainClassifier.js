// src/services/compliance/DomainClassifier.js
//
// DomainClassifier
// ----------------
// Domain-aware classifier: “what is this ingredient/material really?”
//
// Pipeline role:
//   imports → intelligence (classification + compliance scan) → StepGraph → automation → (optional) Hub export
//
// This module maps free-text items (ingredients, materials, products) into
// canonical objects with tag flags that the compliance engine understands.
// It does NOT mutate inventory or create sessions, so it does not export to Hub.
//
// API:
//   export async function classifyItems(domain, rawItems)
//
//   // domain: "cooking" | "cleaning" | "garden" | "animals" | (future: "preservation", "storehouse")
//   // rawItems: strings from user upload/entry or normalized domain artifacts
//   // returns: [{ id, name, canonicalName, domain, tags, meta }]
//
// Example:
//   "pork bacon" → { tags: { isPork: true, isMeat: true } }
//   "bleach"     → { tags: { isCleaningChemical: true, isBleach: true } }
//   "Roundup"    → { tags: { isHerbicide: true, isInvasiveRisk: true } }
//
// This is used by all domains prior to compliance evaluation.

/* ---------------------------------- Imports ---------------------------------- */

import { emitEvent } from "../events/eventBus";

/* --------------------------------- Constants --------------------------------- */

const MODULE_SOURCE = "services.compliance.DomainClassifier";

/**
 * Supported domains (forward-compatible: we allow unknown domains but warn).
 */
const SUPPORTED_DOMAINS = Object.freeze([
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "preservation",
  "storehouse",
]);

/**
 * Common tags we may set on classified items.
 * This list is *not* exhaustive but documents the core vocabulary:
 *
 *   isPork, isMeat, isShellfish, isFish, isDairy, isEgg,
 *   isSeedOil, isUltraProcessed,
 *   isCleaningChemical, isBleach, isFragranceHeavy,
 *   isHerbicide, isPesticide, isFertilizerSynthetic,
 *   isInvasiveRisk,
 *   isDrugAntibiotic, isDrugHormone,
 *   isAllergenNut, isAllergenDairy, isAllergenGluten, isAllergenSoy,
 *   isUncleanBiblical, isTorahRestricted,
 *   category: "meat" | "seafood" | "vegetable" | "spice" | "chemical" | "herbicide" | "pesticide" | ...
 *
 * Tag objects are simple boolean maps + optional category for consumers.
 */

/* ----------------------------- Public API: classify -------------------------- */

/**
 * Classify free-text items into canonical objects with domain-aware tags.
 *
 * @param {string} domain
 * @param {string[]|any[]} rawItems
 * @returns {Promise<Array<{
 *   id: string,
 *   name: string,
 *   canonicalName: string,
 *   domain: string,
 *   tags: Record<string, boolean|string>,
 *   meta: Record<string, any>
 * }>>}
 */
export async function classifyItems(domain, rawItems) {
  const ts = new Date().toISOString();

  const normalizedDomain = typeof domain === "string" ? domain.trim() : "";
  if (!normalizedDomain) {
    emitSafe({
      type: "compliance.domainClassification.failed",
      ts,
      source: MODULE_SOURCE,
      data: {
        reason: "Missing domain",
        domain,
        itemCount: Array.isArray(rawItems) ? rawItems.length : 0,
      },
    });
    return [];
  }

  if (!SUPPORTED_DOMAINS.includes(normalizedDomain)) {
    // Forward-compatible: we still classify, but warn for observability.
    if (typeof console !== "undefined") {
      console.warn(
        `[DomainClassifier] classifyItems called with unsupported domain "${normalizedDomain}". Proceeding anyway.`
      );
    }
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    emitSafe({
      type: "compliance.domainClassification.completed",
      ts,
      source: MODULE_SOURCE,
      data: { domain: normalizedDomain, itemCount: 0, emptyInput: true },
    });
    return [];
  }

  const results = [];

  // Sync classification now; leaving async hook for future remote/services calls.
  for (let i = 0; i < rawItems.length; i += 1) {
    const raw = rawItems[i];

    const name =
      typeof raw === "string"
        ? raw
        : typeof raw?.name === "string"
        ? raw.name
        : typeof raw?.label === "string"
        ? raw.label
        : "";

    const trimmed = name.trim();
    if (!trimmed) continue;

    const canonicalName = canonicalizeName(trimmed);
    const tags = classifySingle(normalizedDomain, canonicalName);

    results.push({
      id: buildId(normalizedDomain, canonicalName, i),
      name: trimmed,
      canonicalName,
      domain: normalizedDomain,
      tags,
      meta: {
        // Keep a shallow hint for debugging / future features.
        index: i,
        original: raw,
      },
    });
  }

  emitSafe({
    type: "compliance.domainClassification.completed",
    ts,
    source: MODULE_SOURCE,
    data: {
      domain: normalizedDomain,
      itemCount: results.length,
      originalCount: rawItems.length,
    },
  });

  return results;
}

/* -------------------------- Core single-item classify ------------------------ */

/**
 * Classify a single normalized name in a given domain.
 *
 * @param {string} domain
 * @param {string} nameLower - pre-lowercased / normalized name
 * @returns {Record<string, boolean|string>}
 */
function classifySingle(domain, nameLower) {
  // Base tags object; category is a string field; other keys are booleans.
  const tags = {
    category: "",
  };

  // General / cross-domain classification first (Torah-relevant, allergens, etc.)
  applyTorahAndAllergenHeuristics(nameLower, tags);
  applyUltraProcessedHeuristics(nameLower, tags);
  applySeedOilHeuristics(nameLower, tags);

  // Domain-specific logic
  switch (domain) {
    case "cooking":
    case "preservation":
    case "storehouse":
      applyCookingPreservationTags(nameLower, tags);
      break;
    case "cleaning":
      applyCleaningTags(nameLower, tags);
      break;
    case "garden":
      applyGardenTags(nameLower, tags);
      break;
    case "animals":
      applyAnimalTags(nameLower, tags);
      break;
    default:
      // For unknown domains, we still rely on general heuristics above.
      break;
  }

  // Final fallback category if none has been set.
  if (!tags.category) {
    tags.category = inferGenericCategory(nameLower, tags);
  }

  return tags;
}

/* ---------------------- Heuristics: Cross-domain (Torah, etc.) --------------- */

/**
 * Torah + allergens classification.
 *
 * @param {string} name
 * @param {Record<string, boolean|string>} tags
 */
function applyTorahAndAllergenHeuristics(name, tags) {
  const n = name;

  // Pork / unclean meats
  if (
    /\b(pork|bacon|ham|prosciutto|salami|pepperoni|lardon|chorizo)\b/.test(n)
  ) {
    tags.isPork = true;
    tags.isMeat = true;
    tags.isUncleanBiblical = true;
    tags.isTorahRestricted = true;
    tags.category = tags.category || "meat";
  }

  // Shellfish / unclean seafood
  if (
    /\b(shrimp|prawn|lobster|crab|crayfish|crawfish|oyster|clam|mussel|scallop|shellfish)\b/.test(
      n
    )
  ) {
    tags.isShellfish = true;
    tags.isFish = true;
    tags.isUncleanBiblical = true;
    tags.isTorahRestricted = true;
    tags.category = tags.category || "seafood";
  }

  // General meat (includes potentially clean meats)
  if (
    /\b(beef|steak|lamb|mutton|goat|chicken|turkey|duck|venison|meat)\b/.test(n)
  ) {
    tags.isMeat = true;
    tags.category = tags.category || "meat";
  }

  // Dairy
  if (/\b(milk|cream|cheese|butter|yogurt|whey|casein)\b/.test(n)) {
    tags.isDairy = true;
    tags.isAllergenDairy = true;
    tags.category = tags.category || "dairy";
  }

  // Egg
  if (/\b(egg|egg yolk|egg white)\b/.test(n)) {
    tags.isEgg = true;
  }

  // Nuts
  if (
    /\b(almond|peanut|cashew|walnut|pecan|hazelnut|pistachio|macadamia)\b/.test(
      n
    )
  ) {
    tags.isAllergenNut = true;
  }

  // Gluten / wheat
  if (/\b(wheat|barley|rye|spelt|farro|durum|gluten)\b/.test(n)) {
    tags.isAllergenGluten = true;
  }

  // Soy
  if (/\b(soy|soya|tofu|tempeh|soybean)\b/.test(n)) {
    tags.isAllergenSoy = true;
  }
}

/**
 * Ultra-processed hints.
 *
 * @param {string} name
 * @param {Record<string, boolean|string>} tags
 */
function applyUltraProcessedHeuristics(name, tags) {
  const n = name;

  if (
    /\b(margarine|corn syrup|high fructose corn syrup|hfcs|processed cheese|cheese product|instant noodle|soda|diet soda|soft drink|candy)\b/.test(
      n
    )
  ) {
    tags.isUltraProcessed = true;
  }

  if (/\b(artificial flavor|artificial colour|artificial color)\b/.test(n)) {
    tags.isUltraProcessed = true;
  }
}

/**
 * Seed oil detection.
 *
 * @param {string} name
 * @param {Record<string, boolean|string>} tags
 */
function applySeedOilHeuristics(name, tags) {
  const n = name;

  if (
    /\b(canola oil|soybean oil|corn oil|cottonseed oil|sunflower oil|safflower oil|grapeseed oil|rice bran oil|vegetable oil)\b/.test(
      n
    )
  ) {
    tags.isSeedOil = true;
    tags.category = tags.category || "oil";
  }
}

/* ---------------------- Domain Heuristics: Cooking/Preservation -------------- */

function applyCookingPreservationTags(name, tags) {
  const n = name;

  // Herbs / spices
  if (
    /\b(basil|oregano|thyme|rosemary|sage|parsley|cilantro|coriander|cumin|paprika|turmeric|ginger|garlic)\b/.test(
      n
    )
  ) {
    tags.category = tags.category || "spice";
  }

  // Sugar & sweeteners
  if (
    /\b(sugar|sucrose|brown sugar|powdered sugar|corn syrup|hfcs)\b/.test(n)
  ) {
    tags.isUltraProcessed = true;
    tags.category = tags.category || "sweetener";
  }

  if (/\b(aspartame|sucralose|acesulfame|saccharin|stevia)\b/.test(n)) {
    tags.isUltraProcessed = true;
    tags.category = tags.category || "sweetener";
  }

  // Cured meats (likely unclean if pork-based, but this may overlap general heuristics)
  if (/\b(bacon|prosciutto|salami|pepperoni)\b/.test(n)) {
    tags.isMeat = true;
    tags.category = tags.category || "meat";
  }

  // Smoked / preserved
  if (/\b(smoked|cured|pickled)\b/.test(n)) {
    tags.isPreserved = true;
  }
}

/* -------------------------- Domain Heuristics: Cleaning ---------------------- */

function applyCleaningTags(name, tags) {
  const n = name;

  // Generic cleaning chemical
  if (
    /\b(cleaner|detergent|degreaser|disinfectant|sanitizer|sanitiser|solvent)\b/.test(
      n
    )
  ) {
    tags.isCleaningChemical = true;
    tags.category = tags.category || "chemical";
  }

  // Bleach
  if (/\b(bleach|sodium hypochlorite)\b/.test(n)) {
    tags.isCleaningChemical = true;
    tags.isBleach = true;
    tags.category = tags.category || "chemical";
  }

  // Fragrance-heavy cleaners
  if (
    /\b(fragrance|parfum|scented|air freshener|fabric softener|dryer sheet)\b/.test(
      n
    )
  ) {
    tags.isCleaningChemical = true;
    tags.isFragranceHeavy = true;
    tags.category = tags.category || "chemical";
  }

  // Ammonia
  if (/\b(ammonia|ammonium hydroxide)\b/.test(n)) {
    tags.isCleaningChemical = true;
    tags.category = tags.category || "chemical";
  }
}

/* --------------------------- Domain Heuristics: Garden ----------------------- */

function applyGardenTags(name, tags) {
  const n = name;

  // Herbicides
  if (/\b(roundup|glyphosate|herbicide|weed killer|weedkiller)\b/.test(n)) {
    tags.isHerbicide = true;
    tags.isInvasiveRisk = true; // chemical invasive risk in soil/ecosystem
    tags.category = tags.category || "herbicide";
  }

  // Pesticides
  if (
    /\b(pesticide|insecticide|fungicide|neonicotinoid|pest control)\b/.test(n)
  ) {
    tags.isPesticide = true;
    tags.category = tags.category || "pesticide";
  }

  // Synthetic fertilizers
  if (
    /\b(fertilizer|fertiliser|n-p-k|npk|ammonium nitrate|urea)\b/.test(n) &&
    !/\b(compost|manure|organic)\b/.test(n)
  ) {
    tags.isFertilizerSynthetic = true;
    tags.category = tags.category || "fertilizer";
  }

  // Invasive plant hints
  if (/\b(kudzu|english ivy|japanese knotweed|bamboo)\b/.test(n)) {
    tags.isInvasiveRisk = true;
    tags.category = tags.category || "plant";
  }
}

/* --------------------------- Domain Heuristics: Animals ---------------------- */

function applyAnimalTags(name, tags) {
  const n = name;

  // Animal feeds (grain-based, may overlap with unclean / waste-based feeds)
  if (
    /\b(feed|ration|pellet|grain mix|chicken feed|hog feed|hog finisher)\b/.test(
      n
    )
  ) {
    tags.isAnimalFeed = true;
    tags.category = tags.category || "feed";
  }

  // Antibiotics
  if (
    /\b(antibiotic|tetracycline|penicillin|oxytetracycline|sulfamethazine|tylosin)\b/.test(
      n
    )
  ) {
    tags.isDrugAntibiotic = true;
    tags.category = tags.category || "drug";
  }

  // Hormones
  if (/\b(hormone|growth promoter|bst|estrogen|testosterone)\b/.test(n)) {
    tags.isDrugHormone = true;
    tags.category = tags.category || "drug";
  }

  // Unclean feeds: blood meal, pork by-products, etc.
  if (/\b(blood meal|meat and bone meal|pork by-product)\b/.test(n)) {
    tags.isUncleanBiblical = true;
    tags.isTorahRestricted = true;
    tags.category = tags.category || "feed";
  }
}

/* ----------------------------- Category Inference ---------------------------- */

/**
 * Infer a generic category when domain-specific tags didn't set one.
 *
 * @param {string} name
 * @param {Record<string, boolean|string>} tags
 * @returns {string}
 */
function inferGenericCategory(name, tags) {
  if (tags.isCleaningChemical || tags.isBleach) return "chemical";
  if (tags.isHerbicide) return "herbicide";
  if (tags.isPesticide) return "pesticide";
  if (tags.isFertilizerSynthetic) return "fertilizer";
  if (tags.isMeat || tags.isPork) return "meat";
  if (tags.isShellfish || tags.isFish) return "seafood";
  if (tags.isDairy) return "dairy";
  if (tags.isSeedOil) return "oil";

  // Very simple word-based fallback
  if (/\b(leaf|leaves|root|seed|flower|herb)\b/.test(name)) return "plant";
  if (/\b(oil)\b/.test(name)) return "oil";
  if (/\b(powder|granule|pellet)\b/.test(name)) return "powder";

  return "unknown";
}

/* --------------------------- Utility / Normalization ------------------------- */

/**
 * Canonicalize a name by lowercasing and collapsing whitespace.
 *
 * @param {string} name
 * @returns {string}
 */
function canonicalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build a deterministic ID for a classified item.
 *
 * @param {string} domain
 * @param {string} canonicalName
 * @param {number} index
 * @returns {string}
 */
function buildId(domain, canonicalName, index) {
  const slug = canonicalName
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return `class:${domain}:${slug || "item"}:${index}`;
}

/* --------------------------------- Events ----------------------------------- */

/**
 * Safe wrapper around eventBus.emitEvent.
 *
 * @param {{ type: string, ts: string, source: string, data: any }} payload
 */
function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;

  try {
    emitEvent(payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[DomainClassifier] Failed to emit event", err);
    }
  }
}
