/**
 * animals/butcheryCutSheet.js
 * ---------------------------
 * How this fits:
 * - Lives under: src/agents/skills/animals/butcheryCutSheet.js
 * - Used by: Animals Dashboard, Storehouse/Inventory, Preservation Planner, and
 *   SessionRunner when building “Now” butchery & packaging sessions.
 *
 * Responsibilities:
 * - Take a slaughter animal profile (species, weights, preferences) and:
 *   • Estimate carcass and packaged yields.
 *   • Break the carcass into primals & retail cuts by species.
 *   • Build cut sheet template lines: {cutName, style, thickness, packSize, etc.}
 *   • Attach swap options per line (e.g., steak-heavy vs roast-heavy vs ground-heavy).
 * - Emit SSA events and optionally export analytics to the Hub.
 *
 * Swap Modal Integration:
 * - This is pure logic. It DOES NOT render UI.
 * - It returns `sheet` with `lines[]` and each line has:
 *     • swapOptions[] (ButcherySwapOption)
 *     • chosenSwapId (resume-aware)
 * - Your ButcheryCutSheetSwapModal (React) should:
 *   • Group lines by primal (e.g., Shoulder, Loin, Leg).
 *   • Allow user to choose variants (e.g., “More ground”, “More roasts”).
 *   • Persist chosenSwapId in Dexie keyed by lineId.
 *   • Remain mounted at app root so selections persist when navigating.
 *
 * Hub Integration:
 * - Exports with: HubPacketFormatter.formatButcheryCutSheet(sheetResult, context)
 *   when familyFundMode === true.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/events/eventBus";
import { familyFundMode } from "../../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/* -------------------------------------------------------------------------- */
/* Typedefs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {"cattle"|"goat"|"sheep"|"lamb"|"poultry"|"rabbit"|"swine"|"other"} ButcherySpecies
 */

/**
 * Minimal slaughter animal profile for cut sheet building.
 *
 * @typedef {Object} SlaughterAnimalProfile
 * @property {string} id
 * @property {string} name
 * @property {ButcherySpecies} [species]
 * @property {number} [liveWeightKg]        - Live weight in kg (if known).
 * @property {number} [liveWeightLb]        - Or live weight in lb.
 * @property {number} [carcassWeightKg]     - Hot carcass weight in kg (if measured).
 * @property {number} [carcassWeightLb]     - Or carcass weight in lb.
 * @property {boolean} [isGrassFed]
 * @property {string} [butcheryPreferenceId] - Optional link to a saved profile.
 * @property {string[]} [tags]              - e.g. ["family-pack","premium-steaks"].
 */

/**
 * User preferences for cut emphasis.
 *
 * @typedef {"balanced"|"steaks-heavy"|"roasts-heavy"|"ground-heavy"|"stew-heavy"} ButcheryStyle
 */

/**
 * Cut sheet line (core template instruction).
 *
 * @typedef {Object} CutSheetLine
 * @property {string} id
 * @property {string} primal              - e.g. "Shoulder","Loin","Leg".
 * @property {string} species             - species key.
 * @property {string} label               - e.g. "Loin chops", "Shoulder roasts".
 * @property {string} style               - "steak","roast","ground","stew","offal","bones","trim".
 * @property {string|null} thickness      - e.g. "1 in", "3/4 in".
 * @property {number|null} packCount      - pieces per package (for cuts).
 * @property {number|null} targetKg       - estimated weight this line represents.
 * @property {string|null} grindFatPct    - e.g. "80/20", "90/10".
 * @property {boolean} [isOptional]
 * @property {string[]} tags              - e.g. ["family-pack","premium","soup-bones"].
 * @property {Object} metadata            - free-form extra info; may include inventory category hints.
 */

/**
 * Swap option for a single cut sheet line.
 *
 * @typedef {Object} ButcherySwapOption
 * @property {string} id
 * @property {string} label               - e.g. "More steaks", "More ground".
 * @property {string} summary             - UX copy for swap modal.
 * @property {"balanced"|"steaks-heavy"|"roasts-heavy"|"ground-heavy"|"stew-heavy"} variant
 * @property {boolean} autoSelected
 * @property {boolean} [isNeutral]
 * @property {string[]} badges            - e.g. ["DEFAULT","FAMILY-PACK","GRILL-FRIENDLY"].
 * @property {Partial<CutSheetLine>} overrides - How this variant modifies the base line.
 */

/**
 * Result for a single cut sheet line (with swaps).
 *
 * @typedef {Object} CutSheetLineResult
 * @property {CutSheetLine} line
 * @property {ButcherySwapOption[]} swapOptions
 * @property {string|null} chosenSwapId
 * @property {string|null} error
 */

/**
 * Entire cut sheet result.
 *
 * @typedef {Object} ButcheryCutSheetResult
 * @property {string} id
 * @property {SlaughterAnimalProfile} animal
 * @property {ButcheryStyle} baseStyle
 * @property {number} liveWeightKg
 * @property {number} carcassWeightKg
 * @property {number} estimatedPackagedKg
 * @property {number} carcassYieldPct
 * @property {number} packagedYieldPct
 * @property {CutSheetLineResult[]} lines
 * @property {Object} meta               - misc info, inventory category hints, etc.
 */

/**
 * Options for cut sheet builder.
 *
 * @typedef {Object} ButcheryCutSheetOptions
 * @property {string} [eventSource="animals"]
 * @property {number} [nowTs]             - Timestamp; defaults to Date.now().
 * @property {ButcheryStyle} [baseStyle="balanced"]
 * @property {Record<string,string>} [chosenSwapByLineId] - Resume map (lineId → swapId).
 * @property {boolean} [includeBones=true]
 * @property {boolean} [includeOffal=true]
 * @property {boolean} [includeTrim=true]
 */

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * SSA event wrapper.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emit(type, source, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[animals/butcheryCutSheet] Failed to emit event:",
      type,
      err
    );
  }
}

/**
 * Convert weights to kg (best-effort).
 *
 * @param {SlaughterAnimalProfile} animal
 * @returns {{ liveWeightKg: number, carcassWeightKg: number, carcassYieldPct: number, packagedYieldKg: number, packagedYieldPct: number }}
 */
function resolveWeights(animal) {
  const liveKg =
    typeof animal.liveWeightKg === "number" && animal.liveWeightKg > 0
      ? animal.liveWeightKg
      : typeof animal.liveWeightLb === "number" && animal.liveWeightLb > 0
      ? animal.liveWeightLb * 0.453592
      : 0;

  const carcassKg =
    typeof animal.carcassWeightKg === "number" && animal.carcassWeightKg > 0
      ? animal.carcassWeightKg
      : typeof animal.carcassWeightLb === "number" && animal.carcassWeightLb > 0
      ? animal.carcassWeightLb * 0.453592
      : liveKg > 0
      ? liveKg * 0.55 // generic dressing %.
      : 0;

  const carcassYieldPct = liveKg > 0 ? (carcassKg / liveKg) * 100 : 0;

  // Generic packaged yield ~ 70% of carcass.
  const packagedYieldKg = carcassKg * 0.7;
  const packagedYieldPct =
    carcassKg > 0 ? (packagedYieldKg / carcassKg) * 100 : 0;

  return {
    liveWeightKg: Math.round(liveKg * 10) / 10,
    carcassWeightKg: Math.round(carcassKg * 10) / 10,
    carcassYieldPct: Math.round(carcassYieldPct * 10) / 10,
    packagedYieldKg: Math.round(packagedYieldKg * 10) / 10,
    packagedYieldPct: Math.round(packagedYieldPct * 10) / 10,
  };
}

/* -------------------------------------------------------------------------- */
/* Species cut templates                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Built-in species/primal yield templates.
 * Values are FRACTIONS of packagedYieldKg (e.g. 0.25 = 25%).
 *
 * This is an extension point: you can move this to JSON or Dexie later.
 */
const SPECIES_BREAKDOWN = {
  cattle: {
    primals: [
      { key: "chuck", label: "Chuck / Shoulder", fraction: 0.26 },
      { key: "rib", label: "Rib", fraction: 0.09 },
      { key: "loin", label: "Short loin / Sirloin", fraction: 0.18 },
      { key: "round", label: "Round", fraction: 0.22 },
      {
        key: "brisketPlateFlank",
        label: "Brisket / Plate / Flank",
        fraction: 0.15,
      },
      { key: "misc", label: "Trim / Stew / Bones / Offal", fraction: 0.1 },
    ],
  },
  goat: {
    primals: [
      { key: "shoulder", label: "Shoulder", fraction: 0.25 },
      { key: "rack", label: "Rack / Rib", fraction: 0.15 },
      { key: "loin", label: "Loin", fraction: 0.2 },
      { key: "leg", label: "Leg", fraction: 0.25 },
      { key: "misc", label: "Trim / Stew / Bones / Offal", fraction: 0.15 },
    ],
  },
  sheep: {
    primals: [
      { key: "shoulder", label: "Shoulder", fraction: 0.24 },
      { key: "rack", label: "Rack / Rib", fraction: 0.16 },
      { key: "loin", label: "Loin", fraction: 0.2 },
      { key: "leg", label: "Leg", fraction: 0.25 },
      { key: "misc", label: "Trim / Stew / Bones / Offal", fraction: 0.15 },
    ],
  },
  lamb: {
    primals: [
      { key: "shoulder", label: "Shoulder", fraction: 0.24 },
      { key: "rack", label: "Rack / Rib", fraction: 0.16 },
      { key: "loin", label: "Loin", fraction: 0.2 },
      { key: "leg", label: "Leg", fraction: 0.25 },
      { key: "misc", label: "Trim / Stew / Bones / Offal", fraction: 0.15 },
    ],
  },
  swine: {
    primals: [
      { key: "shoulder", label: "Shoulder / Boston butt", fraction: 0.28 },
      { key: "loin", label: "Loin", fraction: 0.22 },
      { key: "belly", label: "Belly / Bacon", fraction: 0.2 },
      { key: "ham", label: "Ham / Leg", fraction: 0.22 },
      { key: "misc", label: "Trim / Bones / Offal", fraction: 0.08 },
    ],
  },
  poultry: {
    primals: [
      { key: "whole", label: "Whole or parted", fraction: 0.9 },
      { key: "offal", label: "Offal / Bones", fraction: 0.1 },
    ],
  },
  rabbit: {
    primals: [
      { key: "whole", label: "Whole / parted", fraction: 0.9 },
      { key: "offal", label: "Offal / Bones", fraction: 0.1 },
    ],
  },
  other: {
    primals: [
      { key: "whole", label: "Whole / generic cuts", fraction: 0.85 },
      { key: "misc", label: "Trim / Bones / Offal", fraction: 0.15 },
    ],
  },
};

/**
 * Resolve species key; default to "other".
 * @param {SlaughterAnimalProfile} animal
 * @returns {ButcherySpecies}
 */
function resolveSpeciesKey(animal) {
  const s = (animal.species || "other").toLowerCase();
  if (SPECIES_BREAKDOWN[s]) return /** @type {ButcherySpecies} */ (s);
  return "other";
}

/* -------------------------------------------------------------------------- */
/* Dexie helpers (optional profiles)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Try to load a saved butchery preference profile (user-defined).
 * This is best-effort; it's fine if nothing exists yet.
 *
 * @param {SlaughterAnimalProfile} animal
 * @returns {Promise<any|null>}
 */
async function fetchButcheryPreferenceProfile(animal) {
  if (!db || !db.butcheryProfiles) return null;

  try {
    if (animal.butcheryPreferenceId && db.butcheryProfiles.get) {
      const profile = await db.butcheryProfiles.get(
        animal.butcheryPreferenceId
      );
      if (profile) return profile;
    }
    if (db.butcheryProfiles.where && animal.species) {
      const speciesProfile = await db.butcheryProfiles
        .where("species")
        .equals(animal.species)
        .first();
      if (speciesProfile) return speciesProfile;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[animals/butcheryCutSheet] Failed to fetch butchery profile:",
      err
    );
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Line builders per species/primal                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build lines for a given species & primal based on baseStyle.
 * Note: weights are estimated at the line level. For UI this is guidance, not exact.
 *
 * @param {string} sheetId
 * @param {SlaughterAnimalProfile} animal
 * @param {ButcheryStyle} baseStyle
 * @param {{ key: string, label: string, fraction: number }} primal
 * @param {number} packagedYieldKg
 * @param {ButcheryCutSheetOptions} options
 * @returns {CutSheetLine[]}
 */
function buildLinesForPrimal(
  sheetId,
  animal,
  baseStyle,
  primal,
  packagedYieldKg,
  options
) {
  const species = resolveSpeciesKey(animal);
  const targetKg = Math.round(packagedYieldKg * primal.fraction * 10) / 10;

  /** @type {CutSheetLine[]} */
  const lines = [];
  const includeBones = options.includeBones !== false;
  const includeOffal = options.includeOffal !== false;
  const includeTrim = options.includeTrim !== false;

  const commonMeta = {
    species,
    primalKey: primal.key,
    primalLabel: primal.label,
    inventoryCategoryHint: null,
  };

  const baseIdPrefix = `${sheetId}_${primal.key}`;

  // Per-species logic
  if (species === "cattle") {
    if (primal.key === "loin") {
      lines.push({
        id: `${baseIdPrefix}_steaks`,
        primal: primal.label,
        species,
        label: "Loin steaks (T-bone, porterhouse, or boneless)",
        style: "steak",
        thickness: "1 in",
        packCount: baseStyle === "family-pack" ? 4 : 2,
        targetKg: Math.round(targetKg * 0.7 * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["premium", "grill", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "beef-steaks" },
      });
      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_trim`,
          primal: primal.label,
          species,
          label: "Loin trim → ground beef",
          style: "ground",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.3 * 10) / 10,
          grindFatPct: animal.isGrassFed ? "90/10" : "80/20",
          isOptional: false,
          tags: ["trim", "ground", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "ground-beef" },
        });
      }
    } else if (primal.key === "chuck") {
      const roastShare =
        baseStyle === "roasts-heavy"
          ? 0.7
          : baseStyle === "ground-heavy"
          ? 0.3
          : 0.5;
      const groundShare = 1 - roastShare;

      lines.push({
        id: `${baseIdPrefix}_roasts`,
        primal: primal.label,
        species,
        label: "Chuck roasts",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: Math.round(targetKg * roastShare * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["roast", "slow-cook", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "beef-roasts" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_ground`,
          primal: primal.label,
          species,
          label: "Chuck trim → ground beef",
          style: "ground",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * groundShare * 10) / 10,
          grindFatPct: animal.isGrassFed ? "85/15" : "80/20",
          isOptional: false,
          tags: ["ground", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "ground-beef" },
        });
      }
    } else if (primal.key === "round") {
      const steakShare =
        baseStyle === "steaks-heavy"
          ? 0.5
          : baseStyle === "ground-heavy"
          ? 0.2
          : 0.35;
      const roastShare = 0.25;
      const groundShare = 1 - steakShare - roastShare;

      lines.push({
        id: `${baseIdPrefix}_steaks`,
        primal: primal.label,
        species,
        label: "Round steaks (thin cut)",
        style: "steak",
        thickness: "3/4 in",
        packCount: 4,
        targetKg: Math.round(targetKg * steakShare * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["steak", "economy", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "beef-steaks" },
      });

      lines.push({
        id: `${baseIdPrefix}_roasts`,
        primal: primal.label,
        species,
        label: "Round roasts",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: Math.round(targetKg * roastShare * 10) / 10,
        grindFatPct: null,
        isOptional: true,
        tags: ["roast", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "beef-roasts" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_ground`,
          primal: primal.label,
          species,
          label: "Round trim → extra-lean ground",
          style: "ground",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * groundShare * 10) / 10,
          grindFatPct: "90/10",
          isOptional: false,
          tags: ["ground", "lean", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "ground-beef" },
        });
      }
    } else if (primal.key === "brisketPlateFlank") {
      lines.push({
        id: `${baseIdPrefix}_brisket`,
        primal: primal.label,
        species,
        label: "Whole / half briskets",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: Math.round(targetKg * 0.6 * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["brisket", "smoke", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "beef-brisket" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_stew`,
          primal: primal.label,
          species,
          label: "Plate / flank trim → stew or ground",
          style: "stew",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.4 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["stew", "trim", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "beef-stew" },
        });
      }
    } else if (primal.key === "rib") {
      lines.push({
        id: `${baseIdPrefix}_ribeyes`,
        primal: primal.label,
        species,
        label: "Ribeye steaks",
        style: "steak",
        thickness: "1 in",
        packCount: baseStyle === "family-pack" ? 4 : 2,
        targetKg: Math.round(targetKg * 0.7 * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["premium", "grill", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "beef-steaks" },
      });

      if (includeBones) {
        lines.push({
          id: `${baseIdPrefix}_bones`,
          primal: primal.label,
          species,
          label: "Rib bones for broth / dog treats",
          style: "bones",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.3 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["bones", "broth", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "bones" },
        });
      }
    } else if (primal.key === "misc") {
      if (includeOffal) {
        lines.push({
          id: `${baseIdPrefix}_offal`,
          primal: primal.label,
          species,
          label: "Offal (liver, heart, tongue, etc.)",
          style: "offal",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.4 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["offal", "nutrient-dense", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "offal" },
        });
      }
      if (includeBones) {
        lines.push({
          id: `${baseIdPrefix}_soupBones`,
          primal: primal.label,
          species,
          label: "Soup / marrow bones",
          style: "bones",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.4 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["bones", "broth", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "bones" },
        });
      }
      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_miscGround`,
          primal: primal.label,
          species,
          label: "Misc trim → ground",
          style: "ground",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.2 * 10) / 10,
          grindFatPct: animal.isGrassFed ? "85/15" : "80/20",
          isOptional: true,
          tags: ["ground", "trim", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "ground-beef" },
        });
      }
    }
  } else if (species === "goat" || species === "sheep" || species === "lamb") {
    if (primal.key === "shoulder") {
      const stewShare =
        baseStyle === "stew-heavy"
          ? 0.6
          : baseStyle === "ground-heavy"
          ? 0.2
          : 0.4;
      const roastShare = 1 - stewShare;

      lines.push({
        id: `${baseIdPrefix}_roasts`,
        primal: primal.label,
        species,
        label: "Shoulder roasts",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: Math.round(targetKg * roastShare * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["roast", "slow-cook", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "goat-roasts" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_stew`,
          primal: primal.label,
          species,
          label: "Shoulder meat → stew cubes",
          style: "stew",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * stewShare * 10) / 10,
          grindFatPct: null,
          isOptional: false,
          tags: ["stew", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "goat-stew" },
        });
      }
    } else if (primal.key === "rack") {
      lines.push({
        id: `${baseIdPrefix}_chops`,
        primal: primal.label,
        species,
        label: "Rib / rack chops",
        style: "steak",
        thickness: "1 in",
        packCount: 4,
        targetKg: targetKg,
        grindFatPct: null,
        isOptional: false,
        tags: ["chops", "grill", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "goat-chops" },
      });
    } else if (primal.key === "loin") {
      lines.push({
        id: `${baseIdPrefix}_loinChops`,
        primal: primal.label,
        species,
        label: "Loin chops",
        style: "steak",
        thickness: "1 in",
        packCount: 4,
        targetKg: targetKg,
        grindFatPct: null,
        isOptional: false,
        tags: ["chops", "grill", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "goat-chops" },
      });
    } else if (primal.key === "leg") {
      const roastShare =
        baseStyle === "roasts-heavy"
          ? 0.8
          : baseStyle === "stew-heavy"
          ? 0.5
          : 0.6;
      const stewShare = 1 - roastShare;

      lines.push({
        id: `${baseIdPrefix}_legRoast`,
        primal: primal.label,
        species,
        label: "Leg roasts (whole or half)",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: Math.round(targetKg * roastShare * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["roast", "holiday", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "goat-roasts" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_legStew`,
          primal: primal.label,
          species,
          label: "Leg trim → stew",
          style: "stew",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * stewShare * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["stew", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "goat-stew" },
        });
      }
    } else if (primal.key === "misc") {
      if (includeBones) {
        lines.push({
          id: `${baseIdPrefix}_bones`,
          primal: primal.label,
          species,
          label: "Neck / shank bones for broth",
          style: "bones",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.5 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["bones", "broth", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "bones" },
        });
      }
      if (includeOffal) {
        lines.push({
          id: `${baseIdPrefix}_offal`,
          primal: primal.label,
          species,
          label: "Offal (liver, heart, kidneys)",
          style: "offal",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.5 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["offal", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "offal" },
        });
      }
    }
  } else if (species === "swine") {
    if (primal.key === "shoulder") {
      const sausageShare =
        baseStyle === "ground-heavy"
          ? 0.6
          : baseStyle === "balanced"
          ? 0.4
          : 0.3;
      const roastShare = 1 - sausageShare;

      lines.push({
        id: `${baseIdPrefix}_buttRoasts`,
        primal: primal.label,
        species,
        label: "Boston butt roasts",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: Math.round(targetKg * roastShare * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["roast", "pulled-pork", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "pork-roasts" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_sausage`,
          primal: primal.label,
          species,
          label: "Shoulder trim → sausage",
          style: "ground",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * sausageShare * 10) / 10,
          grindFatPct: "75/25",
          isOptional: false,
          tags: ["sausage", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "pork-sausage" },
        });
      }
    } else if (primal.key === "loin") {
      lines.push({
        id: `${baseIdPrefix}_chops`,
        primal: primal.label,
        species,
        label: "Pork chops",
        style: "steak",
        thickness: "3/4 in",
        packCount: 4,
        targetKg: Math.round(targetKg * 0.7 * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["chops", "grill", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "pork-chops" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_loinRoast`,
          primal: primal.label,
          species,
          label: "Loin roasts",
          style: "roast",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.3 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["roast", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "pork-roasts" },
        });
      }
    } else if (primal.key === "belly") {
      lines.push({
        id: `${baseIdPrefix}_bacon`,
        primal: primal.label,
        species,
        label: "Belly → bacon",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: targetKg,
        grindFatPct: null,
        isOptional: false,
        tags: ["bacon", "cure", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "pork-bacon" },
      });
    } else if (primal.key === "ham") {
      const hamShare =
        baseStyle === "roasts-heavy"
          ? 0.8
          : baseStyle === "ground-heavy"
          ? 0.5
          : 0.7;
      const groundShare = 1 - hamShare;

      lines.push({
        id: `${baseIdPrefix}_hams`,
        primal: primal.label,
        species,
        label: "Whole / half hams",
        style: "roast",
        thickness: null,
        packCount: null,
        targetKg: Math.round(targetKg * hamShare * 10) / 10,
        grindFatPct: null,
        isOptional: false,
        tags: ["ham", "holiday", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "pork-ham" },
      });

      if (includeTrim) {
        lines.push({
          id: `${baseIdPrefix}_hamSausage`,
          primal: primal.label,
          species,
          label: "Ham trim → ground / sausage",
          style: "ground",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * groundShare * 10) / 10,
          grindFatPct: "80/20",
          isOptional: true,
          tags: ["ground", "sausage", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "pork-sausage" },
        });
      }
    } else if (primal.key === "misc") {
      if (includeBones) {
        lines.push({
          id: `${baseIdPrefix}_bones`,
          primal: primal.label,
          species,
          label: "Bones for broth / dog",
          style: "bones",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.5 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["bones", "broth", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "bones" },
        });
      }
      if (includeOffal) {
        lines.push({
          id: `${baseIdPrefix}_offal`,
          primal: primal.label,
          species,
          label: "Offal (liver, heart, etc.)",
          style: "offal",
          thickness: null,
          packCount: null,
          targetKg: Math.round(targetKg * 0.5 * 10) / 10,
          grindFatPct: null,
          isOptional: true,
          tags: ["offal", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "offal" },
        });
      }
    }
  } else {
    // Generic / poultry / rabbit etc.
    if (primal.key === "whole") {
      lines.push({
        id: `${baseIdPrefix}_whole`,
        primal: primal.label,
        species,
        label: "Whole carcasses",
        style: "roast",
        thickness: null,
        packCount: species === "poultry" ? 1 : null,
        targetKg: targetKg,
        grindFatPct: null,
        isOptional: false,
        tags: ["whole", baseStyle],
        metadata: { ...commonMeta, inventoryCategoryHint: "whole" },
      });
    } else if (primal.key === "offal") {
      if (includeOffal) {
        lines.push({
          id: `${baseIdPrefix}_offal`,
          primal: primal.label,
          species,
          label: "Offal (gizzards, liver, heart, etc.)",
          style: "offal",
          thickness: null,
          packCount: null,
          targetKg: targetKg,
          grindFatPct: null,
          isOptional: true,
          tags: ["offal", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "offal" },
        });
      }
    } else if (primal.key === "misc") {
      if (includeBones) {
        lines.push({
          id: `${baseIdPrefix}_bones`,
          primal: primal.label,
          species,
          label: "Bones for broth",
          style: "bones",
          thickness: null,
          packCount: null,
          targetKg: targetKg,
          grindFatPct: null,
          isOptional: true,
          tags: ["bones", "broth", baseStyle],
          metadata: { ...commonMeta, inventoryCategoryHint: "bones" },
        });
      }
    }
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Swap options builder                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build swap options for a given cut sheet line.
 *
 * Variants:
 * - balanced       (default)
 * - steaks-heavy   (more steaks, fewer roasts/ground)
 * - roasts-heavy   (more roasts, fewer steaks)
 * - ground-heavy   (more ground / sausage)
 * - stew-heavy     (more stew cubes)
 *
 * Implementation:
 * - We don't change the base line object here; we just indicate override
 *   preferences that the UI can apply when building the final "locked" sheet.
 *
 * @param {CutSheetLine} line
 * @param {ButcheryStyle} baseStyle
 * @returns {ButcherySwapOption[]}
 */
function buildSwapOptionsForLine(line, baseStyle) {
  const variants = /** @type {ButcheryStyle[]} */ ([
    "balanced",
    "steaks-heavy",
    "roasts-heavy",
    "ground-heavy",
    "stew-heavy",
  ]);

  /** @type {ButcherySwapOption[]} */
  const options = [];

  for (const variant of variants) {
    /** @type {string[]} */
    const badges = [];

    if (variant === "balanced") badges.push("DEFAULT", "FLEX");
    if (variant === "steaks-heavy") badges.push("GRILL-FRIENDLY");
    if (variant === "roasts-heavy") badges.push("SLOW-COOK");
    if (variant === "ground-heavy") badges.push("FAMILY-PACK", "MEAL-PREP");
    if (variant === "stew-heavy") badges.push("SOUP-STEW");

    const overrides = /** @type {Partial<CutSheetLine>} */ ({});

    // Very light-touch overrides: we only suggest what to do, not re-balance weights exactly.
    if (variant === "steaks-heavy" && line.style === "steak") {
      overrides.packCount =
        typeof line.packCount === "number" ? line.packCount + 1 : 4;
    }
    if (variant === "roasts-heavy" && line.style === "roast") {
      overrides.targetKg =
        typeof line.targetKg === "number"
          ? Math.round(line.targetKg * 1.1 * 10) / 10
          : null;
    }
    if (variant === "ground-heavy" && line.style === "ground") {
      overrides.targetKg =
        typeof line.targetKg === "number"
          ? Math.round(line.targetKg * 1.15 * 10) / 10
          : null;
      overrides.packCount =
        typeof line.packCount === "number" ? line.packCount + 1 : null;
    }
    if (variant === "stew-heavy" && line.style === "stew") {
      overrides.targetKg =
        typeof line.targetKg === "number"
          ? Math.round(line.targetKg * 1.1 * 10) / 10
          : null;
    }

    let summary;
    if (variant === "balanced") {
      summary = "Use a balanced mix of steaks, roasts, ground, and stew cuts.";
    } else if (variant === "steaks-heavy") {
      summary = "Emphasize steaks and quick-cook cuts from this primal.";
    } else if (variant === "roasts-heavy") {
      summary = "Favor roasts / big-family meals from this primal.";
    } else if (variant === "ground-heavy") {
      summary =
        "Channel more of this primal into ground / sausage for flexible meals.";
    } else {
      summary = "Increase stew/soup-friendly pieces from this primal.";
    }

    options.push({
      id: `${line.id}:${variant}`,
      label: variant.replace("-", " "),
      summary,
      variant,
      autoSelected:
        variant === baseStyle ||
        (variant === "balanced" && baseStyle === "balanced"),
      isNeutral: variant === "balanced",
      badges,
      overrides,
    });
  }

  // Ensure exactly one autoSelected
  if (!options.some((o) => o.autoSelected)) {
    const balancedOpt = options.find((o) => o.variant === "balanced");
    if (balancedOpt) balancedOpt.autoSelected = true;
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export cut sheet result to Hub (if familyFundMode is enabled).
 *
 * @param {ButcheryCutSheetResult} sheet
 * @param {string} eventSource
 */
async function exportCutSheetToHub(sheet, eventSource) {
  if (!familyFundMode || !sheet || !sheet.lines || !sheet.lines.length) return;

  try {
    const payload = HubPacketFormatter.formatButcheryCutSheet(sheet, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("animals.butchery.cutsheet.exported", eventSource, {
      lines: sheet.lines.length,
      animalId: sheet.animal.id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[animals/butcheryCutSheet] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a cut sheet template for a slaughter animal.
 *
 * Emits:
 * - animals.butchery.cutsheet.requested
 * - animals.butchery.cutsheet.lines.built
 * - animals.butchery.cutsheet.completed
 * - animals.butchery.cutsheet.exported (on Hub export success)
 *
 * Integration with SessionRunner:
 * - A downstream ButcherySessionBuilder can:
 *   • Read the locked cut sheet from Dexie,
 *   • Turn each line into Session steps (cutting, bagging, labeling),
 *   • Use domain: "animals" or "preservation" with detailed steps.
 *
 * @param {SlaughterAnimalProfile} animal
 * @param {ButcheryCutSheetOptions} [options]
 * @returns {Promise<ButcheryCutSheetResult>}
 */
export async function buildButcheryCutSheet(animal, options = {}) {
  const {
    eventSource = "animals",
    nowTs = Date.now(),
    baseStyle = "balanced",
    chosenSwapByLineId = {},
  } = options;

  if (!animal || !animal.id) {
    throw new Error("buildButcheryCutSheet: animal with id is required.");
  }

  emit("animals.butchery.cutsheet.requested", eventSource, {
    animalId: animal.id,
    baseStyle,
  });

  const weights = resolveWeights(animal);
  const speciesKey = resolveSpeciesKey(animal);
  const breakdown = SPECIES_BREAKDOWN[speciesKey] ||
    SPECIES_BREAKDOWN.other || {
      primals: [],
    };

  const profile = await fetchButcheryPreferenceProfile(animal);
  const sheetId = `cs_${animal.id}_${Math.floor(nowTs / 1000)}`;

  /** @type {CutSheetLine[]} */
  let lines = [];

  for (const primal of breakdown.primals) {
    // If profile defines custom fractions per primal, apply override.
    const fractionOverride =
      profile &&
      profile.primals &&
      typeof profile.primals[primal.key]?.fraction === "number"
        ? profile.primals[primal.key].fraction
        : primal.fraction;

    const adjustedPrimal = {
      ...primal,
      fraction: fractionOverride,
    };

    const primalLines = buildLinesForPrimal(
      sheetId,
      animal,
      baseStyle,
      adjustedPrimal,
      weights.packagedYieldKg,
      options
    );
    lines = lines.concat(primalLines);
  }

  emit("animals.butchery.cutsheet.lines.built", eventSource, {
    animalId: animal.id,
    species: speciesKey,
    lineCount: lines.length,
  });

  /** @type {CutSheetLineResult[]} */
  const lineResults = [];

  for (const line of lines) {
    try {
      const swapOptions = buildSwapOptionsForLine(line, baseStyle);
      const resumeId = chosenSwapByLineId[line.id];

      const chosen =
        (resumeId && swapOptions.find((opt) => opt.id === resumeId)) ||
        swapOptions.find((opt) => opt.autoSelected) ||
        swapOptions[0] ||
        null;

      lineResults.push({
        line,
        swapOptions,
        chosenSwapId: chosen ? chosen.id : null,
        error: null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[animals/butcheryCutSheet] Failed to build swaps for line:",
        line,
        err
      );
      lineResults.push({
        line,
        swapOptions: [],
        chosenSwapId: null,
        error: err?.message || String(err),
      });
    }
  }

  /** @type {ButcheryCutSheetResult} */
  const sheet = {
    id: sheetId,
    animal,
    baseStyle,
    liveWeightKg: weights.liveWeightKg,
    carcassWeightKg: weights.carcassWeightKg,
    estimatedPackagedKg: weights.packagedYieldKg,
    carcassYieldPct: weights.carcassYieldPct,
    packagedYieldPct: weights.packagedYieldPct,
    lines: lineResults,
    meta: {
      species: speciesKey,
      profileId: animal.butcheryPreferenceId || null,
      createdAt: new Date(nowTs).toISOString(),
      notes:
        "Template cut sheet only. Final pack weights will depend on actual cutting and trimming.",
    },
  };

  emit("animals.butchery.cutsheet.completed", eventSource, {
    animalId: animal.id,
    species: speciesKey,
    lines: lineResults.length,
  });

  // Fire-and-forget Hub export.
  exportCutSheetToHub(sheet, eventSource).catch(() => {});

  return sheet;
}

/**
 * Convenience helper:
 * Build a cut sheet and immediately persist it to Dexie (if a table exists).
 *
 * Tables:
 * - Expects db.butcheryCutSheets to exist, with at least {id} primary key.
 *
 * @param {SlaughterAnimalProfile} animal
 * @param {ButcheryCutSheetOptions} [options]
 * @returns {Promise<ButcheryCutSheetResult>}
 */
export async function buildAndStoreButcheryCutSheet(animal, options = {}) {
  const sheet = await buildButcheryCutSheet(animal, options);

  if (db && db.butcheryCutSheets && db.butcheryCutSheets.put) {
    try {
      await db.butcheryCutSheets.put(sheet);
      emit(
        "animals.butchery.cutsheet.stored",
        options.eventSource || "animals",
        {
          animalId: animal.id,
          sheetId: sheet.id,
        }
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[animals/butcheryCutSheet] Failed to store cut sheet in Dexie:",
        err
      );
    }
  }

  return sheet;
}
