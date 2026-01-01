/**
 * animals/sausageRatios.js
 * ------------------------
 * How this fits:
 * - Lives under: src/agents/skills/animals/sausageRatios.js
 * - Used by: Butchery planner, Preservation planner, Batch Session Builder,
 *   and SessionRunner when building “Now” sausage-making sessions.
 *
 * Responsibilities:
 * - Provide sane, override-able ratio tables for sausage production:
 *    • lean/fat ratios by species & style,
 *    • salt %,
 *    • seasoning %,
 *    • liquid/binder % (ice, water, milk powder, rusk, etc.).
 * - Given a total batch weight (or target number of packs), compute:
 *    • kg of lean,
 *    • kg of fat,
 *    • kg of liquid,
 *    • kg of binder,
 *    • kg of seasoning & salt.
 * - Attach swap options per batch profile so a root-mounted
 *   SausageRatioSwapModal can present:
 *    • “Standard breakfast”, “Extra lean”, “Low sodium”, etc.
 *   and persist the user’s choice in Dexie.
 *
 * Swap Modal Integration:
 * - This file is pure logic. It does NOT render UI.
 * - It returns `batchPlan` objects that include:
 *    • ratioProfile (current chosen),
 *    • swapOptions[] (SausageRatioSwapOption),
 *    • chosenSwapId (resume-aware).
 * - Your SausageRatioSwapModal should:
 *    • list style options (Breakfast, Italian, Brat, Smoked, etc.),
 *    • highlight changes to fat %, salt %, and seasoning intensity,
 *    • store chosenSwapId keyed by batchPlan.id in Dexie.
 *
 * Hub Integration:
 * - Exports with: HubPacketFormatter.formatSausageBatchPlan(batchPlan, context)
 *   when familyFundMode === true.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/eventBus";
import { familyFundMode } from "../../../services/featureFlags";
import { HubPacketFormatter } from "../../../services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "../../../services/hub/FamilyFundConnector";

/* -------------------------------------------------------------------------- */
/* Typedefs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Supported sausage species keys.
 * @typedef {"pork"|"beef"|"lamb"|"goat"|"poultry"|"mixed"|"other"} SausageSpecies
 */

/**
 * Styles describe the “use case” of the sausage.
 * @typedef {"breakfast"|"italian"|"bratwurst"|"smoked"|"fresh"|"low-sodium"|"extra-lean"|"high-fat"} SausageStyle
 */

/**
 * Ratio profile (percent by total meat+fat weight, 0–1 fractions).
 *
 * All fractions are relative to TOTAL batch weight unless otherwise noted.
 *
 * @typedef {Object} SausageRatioProfile
 * @property {string} id                     - e.g. "pork:breakfast:standard".
 * @property {SausageSpecies} species
 * @property {SausageStyle} style
 * @property {string} label                  - UX label.
 * @property {string} description            - Short description for UI tooltips.
 * @property {number} leanFrac               - Fraction of batch that is lean meat.
 * @property {number} fatFrac                - Fraction that is backfat / trimmable fat.
 * @property {number} saltFrac               - Salt fraction (by total weight).
 * @property {number} seasoningFrac          - Seasoning blend fraction (by total weight).
 * @property {number} liquidFrac             - Liquid (ice/water/milk) fraction (by total weight).
 * @property {number} binderFrac             - Binder/emulsifier fraction (milk/rusk/etc).
 * @property {string[]} tags                 - e.g. ["mild","family-friendly"].
 * @property {Object} metadata               - Arbitrary extra hints, e.g. grind sizes.
 */

/**
 * Swap option for one ratio profile.
 *
 * @typedef {Object} SausageRatioSwapOption
 * @property {string} id
 * @property {string} label                  - “Standard”, “Low sodium”, “Extra lean”, etc.
 * @property {string} summary                - Description for swap modal.
 * @property {SausageStyle} styleVariant     - Which style this variant represents.
 * @property {boolean} autoSelected
 * @property {boolean} [isNeutral]
 * @property {string[]} badges               - e.g. ["DEFAULT","KID-FRIENDLY","LOW-SODIUM"].
 * @property {Partial<SausageRatioProfile>} overrides - How this changes the base profile.
 */

/**
 * Full batch plan: numeric breakdown based on a ratio profile.
 *
 * @typedef {Object} SausageBatchPlan
 * @property {string} id                     - e.g. "sbp_<ts>_<species>".
 * @property {SausageRatioProfile} ratioProfile
 * @property {number} batchKg                - Total batch mass in kg.
 * @property {number} leanKg
 * @property {number} fatKg
 * @property {number} saltKg
 * @property {number} seasoningKg
 * @property {number} liquidKg
 * @property {number} binderKg
 * @property {number} estPackCount           - Rough estimate for # packs (e.g. 0.45kg / 1 lb each).
 * @property {string[]} notes                - Text notes for UI.
 * @property {SausageRatioSwapOption[]} swapOptions
 * @property {string|null} chosenSwapId
 * @property {Object} meta                   - e.g. grind sizes, smoke suggestions, createdAt.
 */

/**
 * Builder options.
 *
 * @typedef {Object} SausageBatchOptions
 * @property {string} [eventSource="animals"]
 * @property {number} [nowTs]                - Timestamp; defaults to Date.now().
 * @property {SausageStyle} [style="fresh"]
 * @property {number} [packSizeKg=0.45]      - Approx pack size to estimate # packs.
 * @property {Record<string,string>} [chosenSwapByBatchId] - For resume (batchId → swapId).
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
    console.error("[animals/sausageRatios] Failed to emit event:", type, err);
  }
}

/**
 * Clamp a fraction to [0, 1].
 * @param {number} value
 * @returns {number}
 */
function clampUnit(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Round a number to 3 decimal places.
 * @param {number} value
 * @returns {number}
 */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Round to 2 decimal places.
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Default ratio tables                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Built-in ratio profiles keyed by species:style.
 *
 * Fractions are relative to total batch weight.
 */
const BASE_RATIO_TABLES = {
  pork: /** @type {Record<SausageStyle, SausageRatioProfile>} */ ({
    breakfast: {
      id: "pork:breakfast:standard",
      species: "pork",
      style: "breakfast",
      label: "Pork Breakfast Sausage (Standard)",
      description:
        "Classic breakfast sausage: moderate fat, 1.6–1.8% salt, gentle seasoning, good for patties or links.",
      leanFrac: 0.7,
      fatFrac: 0.3,
      saltFrac: 0.017,
      seasoningFrac: 0.015,
      liquidFrac: 0.05,
      binderFrac: 0.01,
      tags: ["mild", "family-friendly", "pan-fry"],
      metadata: {
        grind: ["6 mm pre-grind", "4.5 mm final"],
        suggestedCasing: "Collagen or 22–26 mm natural hog",
      },
    },
    italian: {
      id: "pork:italian:standard",
      species: "pork",
      style: "italian",
      label: "Pork Italian Sausage (Fresh)",
      description:
        "Italian-style sausage: moderate fat, 1.7–2.0% salt, higher seasoning, fennel-forward.",
      leanFrac: 0.7,
      fatFrac: 0.3,
      saltFrac: 0.018,
      seasoningFrac: 0.02,
      liquidFrac: 0.04,
      binderFrac: 0.0,
      tags: ["garlic", "fennel", "fresh"],
      metadata: {
        grind: ["6–8 mm single grind"],
        suggestedCasing: "32–35 mm hog",
      },
    },
    bratwurst: {
      id: "pork:bratwurst:standard",
      species: "pork",
      style: "bratwurst",
      label: "Bratwurst (Pork, Fresh)",
      description:
        "Fresh bratwurst: slightly lower fat than breakfast, mild seasoning, good grill behavior.",
      leanFrac: 0.75,
      fatFrac: 0.25,
      saltFrac: 0.017,
      seasoningFrac: 0.012,
      liquidFrac: 0.06,
      binderFrac: 0.01,
      tags: ["grill", "mild"],
      metadata: {
        grind: ["8 mm coarse", "4.5 mm final option"],
        suggestedCasing: "30–32 mm hog",
      },
    },
    smoked: {
      id: "pork:smoked:standard",
      species: "pork",
      style: "smoked",
      label: "Smoked Sausage / Kielbasa (Pork-heavy)",
      description:
        "Smoked sausage: slightly higher fat for juiciness after smoking, moderate salt.",
      leanFrac: 0.65,
      fatFrac: 0.35,
      saltFrac: 0.018,
      seasoningFrac: 0.018,
      liquidFrac: 0.06,
      binderFrac: 0.015,
      tags: ["smoked", "juicy"],
      metadata: {
        grind: ["6 mm single grind"],
        hotSmokeTempF: 165,
      },
    },
    fresh: {
      id: "pork:fresh:standard",
      species: "pork",
      style: "fresh",
      label: "Generic Fresh Sausage (Pork)",
      description:
        "Balanced fresh sausage base: flexible for custom seasoning blends.",
      leanFrac: 0.72,
      fatFrac: 0.28,
      saltFrac: 0.017,
      seasoningFrac: 0.015,
      liquidFrac: 0.05,
      binderFrac: 0.01,
      tags: ["template", "flexible"],
      metadata: {
        grind: ["6 mm grind"],
      },
    },
    "low-sodium": {
      id: "pork:low-sodium:standard",
      species: "pork",
      style: "low-sodium",
      label: "Low Sodium Pork Sausage",
      description:
        "Reduced-salt base; emphasize herbs, spices, and aromatics to keep flavor.",
      leanFrac: 0.72,
      fatFrac: 0.28,
      saltFrac: 0.011,
      seasoningFrac: 0.02,
      liquidFrac: 0.05,
      binderFrac: 0.01,
      tags: ["low-sodium"],
      metadata: {
        grind: ["6 mm grind"],
      },
    },
    "extra-lean": {
      id: "pork:extra-lean:standard",
      species: "pork",
      style: "extra-lean",
      label: "Extra Lean Pork Sausage",
      description:
        "Lean-focused sausage base; more binder and liquid to avoid dry texture.",
      leanFrac: 0.85,
      fatFrac: 0.15,
      saltFrac: 0.018,
      seasoningFrac: 0.017,
      liquidFrac: 0.07,
      binderFrac: 0.02,
      tags: ["lean"],
      metadata: {
        grind: ["4.5 mm fine grind"],
      },
    },
    "high-fat": {
      id: "pork:high-fat:standard",
      species: "pork",
      style: "high-fat",
      label: "High Fat Pork Sausage",
      description:
        "Richer sausage; useful for mixing with lean game (venison, goat, etc.).",
      leanFrac: 0.55,
      fatFrac: 0.45,
      saltFrac: 0.017,
      seasoningFrac: 0.015,
      liquidFrac: 0.05,
      binderFrac: 0.01,
      tags: ["rich", "blend-base"],
      metadata: {
        grind: ["6–8 mm coarse"],
      },
    },
  }),
  beef: /** @type {Record<SausageStyle, SausageRatioProfile>} */ ({
    fresh: {
      id: "beef:fresh:standard",
      species: "beef",
      style: "fresh",
      label: "Fresh Beef Sausage",
      description:
        "Beef-based fresh sausage or ground mix; good template for custom profiles.",
      leanFrac: 0.8,
      fatFrac: 0.2,
      saltFrac: 0.017,
      seasoningFrac: 0.015,
      liquidFrac: 0.04,
      binderFrac: 0.01,
      tags: ["beef", "template"],
      metadata: {
        grind: ["6 mm grind"],
      },
    },
    smoked: {
      id: "beef:smoked:standard",
      species: "beef",
      style: "smoked",
      label: "Beef Smoked Sausage (e.g. beef sausage / hot links base)",
      description:
        "Beef-focused smoked sausage; slightly higher fat and binder for smoking.",
      leanFrac: 0.75,
      fatFrac: 0.25,
      saltFrac: 0.018,
      seasoningFrac: 0.018,
      liquidFrac: 0.05,
      binderFrac: 0.015,
      tags: ["smoked"],
      metadata: {
        grind: ["6 mm grind"],
      },
    },
    breakfast: {
      id: "beef:breakfast:standard",
      species: "beef",
      style: "breakfast",
      label: "Beef Breakfast Sausage",
      description:
        "Lean breakfast sausage using beef, with slightly more binder to keep tenderness.",
      leanFrac: 0.82,
      fatFrac: 0.18,
      saltFrac: 0.017,
      seasoningFrac: 0.018,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["breakfast"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    "extra-lean": {
      id: "beef:extra-lean:standard",
      species: "beef",
      style: "extra-lean",
      label: "Extra Lean Beef Sausage",
      description:
        "Very lean beef sausage template; useful for health-focused products.",
      leanFrac: 0.9,
      fatFrac: 0.1,
      saltFrac: 0.017,
      seasoningFrac: 0.017,
      liquidFrac: 0.07,
      binderFrac: 0.025,
      tags: ["lean"],
      metadata: {
        grind: ["4.5 mm fine grind"],
      },
    },
    "low-sodium": {
      id: "beef:low-sodium:standard",
      species: "beef",
      style: "low-sodium",
      label: "Low Sodium Beef Sausage",
      description: "Reduced-salt beef sausage base.",
      leanFrac: 0.82,
      fatFrac: 0.18,
      saltFrac: 0.011,
      seasoningFrac: 0.02,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["low-sodium"],
      metadata: {
        grind: ["6 mm"],
      },
    },
    italian: {
      id: "beef:italian:standard",
      species: "beef",
      style: "italian",
      label: "Beef Italian Sausage (Lean)",
      description:
        "Italian-style beef sausage; leaner, stronger seasoning to carry flavor.",
      leanFrac: 0.85,
      fatFrac: 0.15,
      saltFrac: 0.018,
      seasoningFrac: 0.022,
      liquidFrac: 0.05,
      binderFrac: 0.015,
      tags: ["italian"],
      metadata: {
        grind: ["6 mm"],
      },
    },
    bratwurst: {
      id: "beef:bratwurst:standard",
      species: "beef",
      style: "bratwurst",
      label: "Beef Bratwurst (Fresh)",
      description:
        "Bratwurst-style flavor but fully beef; good for grill-friendly links.",
      leanFrac: 0.8,
      fatFrac: 0.2,
      saltFrac: 0.017,
      seasoningFrac: 0.014,
      liquidFrac: 0.05,
      binderFrac: 0.015,
      tags: ["bratwurst"],
      metadata: {
        grind: ["6–8 mm coarse"],
      },
    },
    "high-fat": {
      id: "beef:high-fat:standard",
      species: "beef",
      style: "high-fat",
      label: "Rich Beef Sausage / Blend Base",
      description:
        "Higher-fat beef sausage; blends well with very lean game or goat.",
      leanFrac: 0.65,
      fatFrac: 0.35,
      saltFrac: 0.017,
      seasoningFrac: 0.016,
      liquidFrac: 0.05,
      binderFrac: 0.01,
      tags: ["rich"],
      metadata: {
        grind: ["6 mm"],
      },
    },
  }),
  lamb: /** @type {Record<SausageStyle, SausageRatioProfile>} */ ({
    fresh: {
      id: "lamb:fresh:standard",
      species: "lamb",
      style: "fresh",
      label: "Fresh Lamb Sausage",
      description:
        "Fresh lamb sausage base; good for Mediterranean or North African seasoning profiles.",
      leanFrac: 0.78,
      fatFrac: 0.22,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.05,
      binderFrac: 0.015,
      tags: ["lamb", "aromatic"],
      metadata: {
        grind: ["6 mm grind"],
      },
    },
    "extra-lean": {
      id: "lamb:extra-lean:standard",
      species: "lamb",
      style: "extra-lean",
      label: "Extra Lean Lamb Sausage",
      description:
        "Lean lamb sausage; binder helps avoid crumbly texture.",
      leanFrac: 0.88,
      fatFrac: 0.12,
      saltFrac: 0.017,
      seasoningFrac: 0.022,
      liquidFrac: 0.07,
      binderFrac: 0.02,
      tags: ["lean"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    "low-sodium": {
      id: "lamb:low-sodium:standard",
      species: "lamb",
      style: "low-sodium",
      label: "Low Sodium Lamb Sausage",
      description: "Reduced sodium lamb sausage base.",
      leanFrac: 0.8,
      fatFrac: 0.2,
      saltFrac: 0.011,
      seasoningFrac: 0.024,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["low-sodium"],
      metadata: {
        grind: ["6 mm"],
      },
    },
    smoked: {
      id: "lamb:smoked:standard",
      species: "lamb",
      style: "smoked",
      label: "Smoked Lamb Sausage",
      description:
        "Smoked lamb sausage with slightly higher binder and liquid for good texture.",
      leanFrac: 0.76,
      fatFrac: 0.24,
      saltFrac: 0.018,
      seasoningFrac: 0.022,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["smoked"],
      metadata: {
        grind: ["6 mm"],
      },
    },
    breakfast: {
      id: "lamb:breakfast:standard",
      species: "lamb",
      style: "breakfast",
      label: "Lamb Breakfast Sausage",
      description:
        "Milder lamb breakfast sausage; more binder and liquid for tender patties.",
      leanFrac: 0.8,
      fatFrac: 0.2,
      saltFrac: 0.017,
      seasoningFrac: 0.018,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["breakfast"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    italian: {
      id: "lamb:italian:standard",
      species: "lamb",
      style: "italian",
      label: "Lamb Italian / Merguez-style Base",
      description:
        "Mediterranean/Italian style lamb sausage; seasoning-forward.",
      leanFrac: 0.78,
      fatFrac: 0.22,
      saltFrac: 0.018,
      seasoningFrac: 0.025,
      liquidFrac: 0.05,
      binderFrac: 0.015,
      tags: ["italian", "spiced"],
      metadata: {
        grind: ["6 mm"],
      },
    },
    bratwurst: {
      id: "lamb:bratwurst:standard",
      species: "lamb",
      style: "bratwurst",
      label: "Lamb Bratwurst",
      description: "Brat-style lamb sausage; grill-friendly and aromatic.",
      leanFrac: 0.78,
      fatFrac: 0.22,
      saltFrac: 0.017,
      seasoningFrac: 0.018,
      liquidFrac: 0.05,
      binderFrac: 0.015,
      tags: ["bratwurst"],
      metadata: {
        grind: ["6–8 mm"],
      },
    },
    "high-fat": {
      id: "lamb:high-fat:standard",
      species: "lamb",
      style: "high-fat",
      label: "Rich Lamb Sausage / Blend Base",
      description:
        "Richer lamb sausage; helpful for blending with very lean goat or game.",
      leanFrac: 0.65,
      fatFrac: 0.35,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.05,
      binderFrac: 0.015,
      tags: ["rich"],
      metadata: {
        grind: ["6 mm"],
      },
    },
  }),
  goat: /** @type {Record<SausageStyle, SausageRatioProfile>} */ ({
    fresh: {
      id: "goat:fresh:standard",
      species: "goat",
      style: "fresh",
      label: "Fresh Goat Sausage (Lean Base)",
      description:
        "Goat is naturally lean; this base expects added pork fat or beef fat.",
      leanFrac: 0.85,
      fatFrac: 0.15,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["lean", "blend-friendly"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    "extra-lean": {
      id: "goat:extra-lean:standard",
      species: "goat",
      style: "extra-lean",
      label: "Extra Lean Goat Sausage",
      description:
        "Maximally lean goat sausage; may be patties rather than cased to avoid crumbly texture.",
      leanFrac: 0.9,
      fatFrac: 0.1,
      saltFrac: 0.017,
      seasoningFrac: 0.022,
      liquidFrac: 0.07,
      binderFrac: 0.025,
      tags: ["very-lean"],
      metadata: {
        grind: ["4.5 mm"],
      },
    },
    smoked: {
      id: "goat:smoked:standard",
      species: "goat",
      style: "smoked",
      label: "Smoked Goat Sausage (with added fat)",
      description:
        "Smoked goat sausage; expects more added pork/beef fat than fresh style.",
      leanFrac: 0.8,
      fatFrac: 0.2,
      saltFrac: 0.018,
      seasoningFrac: 0.022,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["smoked"],
      metadata: {
        grind: ["6 mm"],
      },
    },
    "low-sodium": {
      id: "goat:low-sodium:standard",
      species: "goat",
      style: "low-sodium",
      label: "Low Sodium Goat Sausage",
      description:
        "Reduced-salt goat sausage; relies on aromatic herbs and spices.",
      leanFrac: 0.85,
      fatFrac: 0.15,
      saltFrac: 0.011,
      seasoningFrac: 0.024,
      liquidFrac: 0.07,
      binderFrac: 0.025,
      tags: ["low-sodium"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    breakfast: {
      id: "goat:breakfast:standard",
      species: "goat",
      style: "breakfast",
      label: "Goat Breakfast Sausage (with added fat)",
      description:
        "Breakfast-style goat sausage; expects extra pork or beef fat to reach 15–20%.",
      leanFrac: 0.83,
      fatFrac: 0.17,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["breakfast"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    italian: {
      id: "goat:italian:standard",
      species: "goat",
      style: "italian",
      label: "Goat Italian Sausage",
      description: "Italian-style goat sausage; bold seasoning, lean profile.",
      leanFrac: 0.86,
      fatFrac: 0.14,
      saltFrac: 0.018,
      seasoningFrac: 0.025,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["italian"],
      metadata: {
        grind: ["6 mm"],
      },
    },
    bratwurst: {
      id: "goat:bratwurst:standard",
      species: "goat",
      style: "bratwurst",
      label: "Goat Bratwurst",
      description:
        "Brat-style goat sausage; good grilled with herb-forward flavor.",
      leanFrac: 0.83,
      fatFrac: 0.17,
      saltFrac: 0.017,
      seasoningFrac: 0.018,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["bratwurst"],
      metadata: {
        grind: ["6–8 mm"],
      },
    },
    "high-fat": {
      id: "goat:high-fat:standard",
      species: "goat",
      style: "high-fat",
      label: "Goat Sausage with Extra Fat (blend base)",
      description:
        "Goat sausage with intentionally higher fat to blend with very lean trimmings.",
      leanFrac: 0.75,
      fatFrac: 0.25,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.06,
      binderFrac: 0.02,
      tags: ["blend-base"],
      metadata: {
        grind: ["6 mm"],
      },
    },
  }),
  poultry: /** @type {Record<SausageStyle, SausageRatioProfile>} */ ({
    fresh: {
      id: "poultry:fresh:standard",
      species: "poultry",
      style: "fresh",
      label: "Fresh Poultry Sausage",
      description:
        "Chicken/turkey sausage base; naturally lean, more binder and liquid.",
      leanFrac: 0.9,
      fatFrac: 0.1,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.08,
      binderFrac: 0.03,
      tags: ["lean"],
      metadata: {
        grind: ["4.5 mm"],
      },
    },
    breakfast: {
      id: "poultry:breakfast:standard",
      species: "poultry",
      style: "breakfast",
      label: "Poultry Breakfast Sausage",
      description:
        "Breakfast-style chicken or turkey sausage; mild but well-seasoned.",
      leanFrac: 0.9,
      fatFrac: 0.1,
      saltFrac: 0.017,
      seasoningFrac: 0.022,
      liquidFrac: 0.08,
      binderFrac: 0.03,
      tags: ["breakfast"],
      metadata: {
        grind: ["4.5 mm"],
      },
    },
    italian: {
      id: "poultry:italian:standard",
      species: "poultry",
      style: "italian",
      label: "Poultry Italian Sausage",
      description: "Italian-style chicken/turkey sausage; lean and aromatic.",
      leanFrac: 0.9,
      fatFrac: 0.1,
      saltFrac: 0.018,
      seasoningFrac: 0.025,
      liquidFrac: 0.08,
      binderFrac: 0.03,
      tags: ["italian"],
      metadata: {
        grind: ["4.5 mm"],
      },
    },
    "low-sodium": {
      id: "poultry:low-sodium:standard",
      species: "poultry",
      style: "low-sodium",
      label: "Low Sodium Poultry Sausage",
      description: "Reduced-salt poultry sausage.",
      leanFrac: 0.9,
      fatFrac: 0.1,
      saltFrac: 0.011,
      seasoningFrac: 0.028,
      liquidFrac: 0.08,
      binderFrac: 0.03,
      tags: ["low-sodium"],
      metadata: {
        grind: ["4.5 mm"],
      },
    },
    "extra-lean": {
      id: "poultry:extra-lean:standard",
      species: "poultry",
      style: "extra-lean",
      label: "Extra Lean Poultry Sausage",
      description:
        "Maximally lean poultry sausage; may be patties or crumbles rather than links.",
      leanFrac: 0.93,
      fatFrac: 0.07,
      saltFrac: 0.017,
      seasoningFrac: 0.024,
      liquidFrac: 0.09,
      binderFrac: 0.035,
      tags: ["very-lean"],
      metadata: {
        grind: ["4.5 mm"],
      },
    },
    smoked: {
      id: "poultry:smoked:standard",
      species: "poultry",
      style: "smoked",
      label: "Smoked Poultry Sausage",
      description:
        "Smoked poultry sausage with additional binder and liquid for juiciness.",
      leanFrac: 0.88,
      fatFrac: 0.12,
      saltFrac: 0.018,
      seasoningFrac: 0.022,
      liquidFrac: 0.085,
      binderFrac: 0.035,
      tags: ["smoked"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    bratwurst: {
      id: "poultry:bratwurst:standard",
      species: "poultry",
      style: "bratwurst",
      label: "Poultry Bratwurst",
      description:
        "Brat-style chicken/turkey sausage; grill-friendly, herb-forward.",
      leanFrac: 0.9,
      fatFrac: 0.1,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.08,
      binderFrac: 0.03,
      tags: ["bratwurst"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
    "high-fat": {
      id: "poultry:high-fat:standard",
      species: "poultry",
      style: "high-fat",
      label: "Richer Poultry Sausage",
      description:
        "Poultry sausage with intentionally higher fat; often achieved by blending in pork fat.",
      leanFrac: 0.82,
      fatFrac: 0.18,
      saltFrac: 0.017,
      seasoningFrac: 0.02,
      liquidFrac: 0.08,
      binderFrac: 0.03,
      tags: ["blend-base"],
      metadata: {
        grind: ["4.5–6 mm"],
      },
    },
  }),
};

/* -------------------------------------------------------------------------- */
/* Helper: Resolve species key & base profile                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a SausageSpecies key from a variety of inputs.
 *
 * @param {string|{species?: string}} input
 * @returns {SausageSpecies}
 */
function resolveSpeciesKey(input) {
  const raw =
    typeof input === "string"
      ? input
      : typeof input === "object" && input && typeof input.species === "string"
      ? input.species
      : "other";

  const s = raw.toLowerCase();
  if (s.includes("pork") || s.includes("hog")) return "pork";
  if (s.includes("beef") || s.includes("cattle")) return "beef";
  if (s.includes("lamb") || s.includes("mutton")) return "lamb";
  if (s.includes("goat")) return "goat";
  if (s.includes("chicken") || s.includes("turkey") || s.includes("poultry"))
    return "poultry";
  if (s.includes("mixed") || s.includes("blend")) return "mixed";
  return "other";
}

/**
 * Get a base ratio profile for a species & style.
 * If style is not defined for that species, fall back to "fresh" or the first.
 *
 * @param {SausageSpecies} species
 * @param {SausageStyle} style
 * @returns {SausageRatioProfile}
 */
function getBaseRatioProfile(species, style) {
  const table = BASE_RATIO_TABLES[species];
  if (!table) {
    // Generic fallback: similar to lean pork fresh.
    return {
      id: `${species || "other"}:${style || "fresh"}:fallback`,
      species: species || "other",
      style: style || "fresh",
      label: "Generic Sausage Template",
      description:
        "Generic sausage ratio template; adjust to taste and record in Dexie for future batches.",
      leanFrac: 0.75,
      fatFrac: 0.25,
      saltFrac: 0.017,
      seasoningFrac: 0.015,
      liquidFrac: 0.05,
      binderFrac: 0.01,
      tags: ["generic"],
      metadata: {
        grind: ["6 mm"],
      },
    };
  }

  const profile = /** @type {SausageRatioProfile|undefined} */ (table[style]);
  if (profile) return profile;

  const freshFallback = /** @type {SausageRatioProfile|undefined} */ (
    table.fresh
  );
  if (freshFallback) return freshFallback;

  const firstKey = Object.keys(table)[0];
  return table[/** @type {SausageStyle} */ (firstKey)];
}

/* -------------------------------------------------------------------------- */
/* Swap options builder                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build swap options for a given base profile.
 *
 * Variants:
 * - fresh          (balanced baseline)
 * - breakfast      (similar fat, more breakfast seasoning)
 * - italian        (more seasoning, herb-forward)
 * - bratwurst      (mild, grill-friendly)
 * - smoked         (more binder & liquid)
 * - low-sodium     (less salt, more seasoning)
 * - extra-lean     (less fat, more binder & liquid)
 * - high-fat       (more fat, good for lean game blends)
 *
 * @param {SausageRatioProfile} base
 * @returns {SausageRatioSwapOption[]}
 */
function buildSwapOptionsForProfile(base) {
  /** @type {SausageStyle[]} */
  const variants = [
    "fresh",
    "breakfast",
    "italian",
    "bratwurst",
    "smoked",
    "low-sodium",
    "extra-lean",
    "high-fat",
  ];

  /** @type {SausageRatioSwapOption[]} */
  const options = [];

  for (const variant of variants) {
    /** @type {string[]} */
    const badges = [];
    const overrides = /** @type {Partial<SausageRatioProfile>} */ ({});

    if (variant === "fresh") {
      badges.push("DEFAULT", "BALANCED");
      overrides.style = "fresh";
      overrides.description =
        "Balanced fresh sausage profile for versatile use.";
    } else if (variant === "breakfast") {
      badges.push("BREAKFAST", "KID-FRIENDLY");
      overrides.style = "breakfast";
      overrides.seasoningFrac = round3(base.seasoningFrac * 1.1);
      overrides.liquidFrac = round3(base.liquidFrac + 0.01);
      overrides.description =
        "Breakfast-style profile with gentle sweetness and sage-forward seasoning.";
    } else if (variant === "italian") {
      badges.push("ITALIAN", "PASTA-FRIENDLY");
      overrides.style = "italian";
      overrides.seasoningFrac = round3(base.seasoningFrac * 1.3);
      overrides.description =
        "Italian-style profile emphasizing garlic, fennel, and herbs.";
    } else if (variant === "bratwurst") {
      badges.push("BRATWURST", "GRILL-FRIENDLY");
      overrides.style = "bratwurst";
      overrides.liquidFrac = round3(base.liquidFrac + 0.01);
      overrides.description =
        "Bratwurst-style profile: mild seasoning, grill-friendly texture.";
    } else if (variant === "smoked") {
      badges.push("SMOKED", "JUICY");
      overrides.style = "smoked";
      overrides.fatFrac = clampUnit(base.fatFrac + 0.05);
      overrides.binderFrac = round3(base.binderFrac + 0.005);
      overrides.liquidFrac = round3(base.liquidFrac + 0.01);
      overrides.description =
        "Smoked sausage profile with extra fat, binder, and liquid for juiciness.";
    } else if (variant === "low-sodium") {
      badges.push("LOW-SODIUM");
      overrides.style = "low-sodium";
      overrides.saltFrac = round3(base.saltFrac * 0.65);
      overrides.seasoningFrac = round3(base.seasoningFrac * 1.3);
      overrides.description =
        "Lower-salt profile; rely on herbs and spices for flavor.";
    } else if (variant === "extra-lean") {
      badges.push("LEAN", "HEALTH-FOCUSED");
      overrides.style = "extra-lean";
      overrides.leanFrac = clampUnit(base.leanFrac + 0.08);
      overrides.fatFrac = clampUnit(base.fatFrac - 0.08);
      overrides.binderFrac = round3(base.binderFrac + 0.01);
      overrides.liquidFrac = round3(base.liquidFrac + 0.02);
      overrides.description =
        "Extra-lean profile; enough binder and liquid to protect against dryness.";
    } else if (variant === "high-fat") {
      badges.push("RICH", "BLEND-BASE");
      overrides.style = "high-fat";
      overrides.leanFrac = clampUnit(base.leanFrac - 0.08);
      overrides.fatFrac = clampUnit(base.fatFrac + 0.08);
      overrides.description =
        "Higher fat profile; ideal for mixing with very lean game or goat.";
    }

    const labelMap = {
      fresh: "Balanced fresh",
      breakfast: "Breakfast-style",
      italian: "Italian-style",
      bratwurst: "Bratwurst-style",
      smoked: "Smoked sausage",
      "low-sodium": "Low sodium",
      "extra-lean": "Extra lean",
      "high-fat": "High fat / blend base",
    };

    options.push({
      id: `${base.id}:${variant}`,
      label: labelMap[variant] || variant,
      summary:
        overrides.description ||
        "Alternative sausage profile with adjusted fat/salt/seasoning.",
      styleVariant: /** @type {SausageStyle} */ (variant),
      autoSelected: base.style === variant,
      isNeutral: variant === "fresh" && base.style === "fresh",
      badges,
      overrides,
    });
  }

  // Ensure at least one autoSelected option
  if (!options.some((o) => o.autoSelected)) {
    const freshOpt = options.find((o) => o.styleVariant === "fresh");
    if (freshOpt) freshOpt.autoSelected = true;
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Dexie helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Optionally load a custom ratio override from Dexie.
 * This allows households to define their own standard recipes.
 *
 * Expected Dexie schema (example):
 *   db.sausageRatioProfiles = { key: "species:style", profile: SausageRatioProfile }
 *
 * @param {SausageSpecies} species
 * @param {SausageStyle} style
 * @returns {Promise<SausageRatioProfile|null>}
 */
async function fetchCustomRatioProfile(species, style) {
  if (!db || !db.sausageRatioProfiles) return null;
  try {
    if (db.sausageRatioProfiles.get) {
      const key = `${species}:${style}`;
      const rec = await db.sausageRatioProfiles.get(key);
      if (rec && rec.profile) return rec.profile;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[animals/sausageRatios] Failed to load custom profile:", err);
  }
  return null;
}

/**
 * Persist a ratio profile override to Dexie.
 *
 * @param {SausageRatioProfile} profile
 * @returns {Promise<void>}
 */
export async function saveCustomRatioProfile(profile) {
  if (!db || !db.sausageRatioProfiles) return;
  try {
    const key = `${profile.species}:${profile.style}`;
    await db.sausageRatioProfiles.put({ key, profile });
    emit("animals.sausage.ratioProfile.saved", "animals", {
      species: profile.species,
      style: profile.style,
      id: profile.id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[animals/sausageRatios] Failed to save custom profile:", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export a sausage batch plan to Hub (if familyFundMode is enabled).
 *
 * @param {SausageBatchPlan} plan
 * @param {string} eventSource
 */
async function exportSausagePlanToHub(plan, eventSource) {
  if (!familyFundMode || !plan) return;

  try {
    const payload = HubPacketFormatter.formatSausageBatchPlan(plan, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("animals.sausage.batchPlan.exported", eventSource, {
      batchId: plan.id,
      species: plan.ratioProfile.species,
      style: plan.ratioProfile.style,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[animals/sausageRatios] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API: ratio profile + batch builder                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the effective ratio profile for a given species & style:
 * - Load defaults from in-memory table,
 * - Overlay with custom Dexie profile when present.
 *
 * Emits:
 * - animals.sausage.ratioProfile.requested
 * - animals.sausage.ratioProfile.resolved
 *
 * @param {string|{species?: string}} speciesInput
 * @param {SausageStyle} style
 * @param {string} [eventSource="animals"]
 * @returns {Promise<SausageRatioProfile>}
 */
export async function resolveSausageRatioProfile(
  speciesInput,
  style,
  eventSource = "animals"
) {
  const species = resolveSpeciesKey(speciesInput);

  emit("animals.sausage.ratioProfile.requested", eventSource, {
    species,
    style,
  });

  const baseProfile = getBaseRatioProfile(species, style);
  const custom = await fetchCustomRatioProfile(species, style);

  /** @type {SausageRatioProfile} */
  const profile = custom
    ? {
        ...baseProfile,
        ...custom,
        id: custom.id || baseProfile.id,
        species,
        style,
      }
    : baseProfile;

  emit("animals.sausage.ratioProfile.resolved", eventSource, {
    species,
    style,
    profileId: profile.id,
    isCustom: !!custom,
  });

  return profile;
}

/**
 * Build a numeric batch plan from a ratio profile and batchKg.
 *
 * Emits:
 * - animals.sausage.batchPlan.requested
 * - animals.sausage.batchPlan.built
 * - animals.sausage.batchPlan.exported (on Hub export success)
 *
 * Integration with SessionRunner:
 * - A downstream SausageSessionBuilder can take this batchPlan and create:
 *    • steps for weighing lean/fat, mixing, grinding, stuffing, linking, etc.
 *    • domain: "preservation" or "animals" (butchery day) as you prefer.
 *
 * @param {string|{species?: string}} speciesInput
 * @param {number} batchKg                - Target batch size in kg.
 * @param {SausageBatchOptions} [options]
 * @returns {Promise<SausageBatchPlan>}
 */
export async function planSausageBatch(speciesInput, batchKg, options = {}) {
  const {
    eventSource = "animals",
    nowTs = Date.now(),
    style = "fresh",
    packSizeKg = 0.45,
    chosenSwapByBatchId = {},
  } = options;

  const species = resolveSpeciesKey(speciesInput);

  if (!Number.isFinite(batchKg) || batchKg <= 0) {
    throw new Error("planSausageBatch: batchKg must be a positive number.");
  }

  emit("animals.sausage.batchPlan.requested", eventSource, {
    species,
    batchKg,
    style,
  });

  const baseProfile = await resolveSausageRatioProfile(
    species,
    style,
    eventSource
  );
  const swapOptions = buildSwapOptionsForProfile(baseProfile);

  // Choose variant (resume-aware)
  const batchId = `sbp_${species}_${Math.floor(nowTs / 1000)}`;
  const resumeId = chosenSwapByBatchId[batchId];
  const chosen =
    (resumeId && swapOptions.find((opt) => opt.id === resumeId)) ||
    swapOptions.find((opt) => opt.autoSelected) ||
    swapOptions[0];

  // Apply overrides to base profile
  const effectiveProfile =
    chosen && chosen.overrides
      ? /** @type {SausageRatioProfile} */ ({
          ...baseProfile,
          ...chosen.overrides,
          id: chosen.id,
        })
      : baseProfile;

  // Calculate component weights
  const leanKg = round2(batchKg * clampUnit(effectiveProfile.leanFrac));
  const fatKg = round2(batchKg * clampUnit(effectiveProfile.fatFrac));
  const saltKg = round2(batchKg * clampUnit(effectiveProfile.saltFrac));
  const seasoningKg = round2(
    batchKg * clampUnit(effectiveProfile.seasoningFrac)
  );
  const liquidKg = round2(batchKg * clampUnit(effectiveProfile.liquidFrac));
  const binderKg = round2(batchKg * clampUnit(effectiveProfile.binderFrac));

  const estPackCount =
    packSizeKg > 0 ? Math.max(1, Math.round(batchKg / packSizeKg)) : 0;

  /** @type {string[]} */
  const notes = [];

  notes.push(
    `Batch mass: ${batchKg.toFixed(2)} kg, ${estPackCount} packs of ~${(
      packSizeKg * 1000
    ).toFixed(0)} g.`
  );
  notes.push(
    `Lean: ${leanKg.toFixed(2)} kg, Fat: ${fatKg.toFixed(
      2
    )} kg (approx ${(leanKg / batchKg * 100).toFixed(1)}% lean).`
  );
  notes.push(
    `Salt: ${saltKg.toFixed(2)} kg (~${(
      effectiveProfile.saltFrac * 100
    ).toFixed(2)}% of batch).`
  );
  notes.push(
    `Seasoning blend: ${seasoningKg.toFixed(2)} kg (~${(
      effectiveProfile.seasoningFrac * 100
    ).toFixed(2)}%).`
  );

  if (liquidKg > 0) {
    notes.push(
      `Liquid/ice: ${liquidKg.toFixed(
        2
      )} kg (${(effectiveProfile.liquidFrac * 100).toFixed(
        1
      )}% of batch) for protein extraction and texture.`
    );
  }
  if (binderKg > 0) {
    notes.push(
      `Binder/emulsifier: ${binderKg.toFixed(
        2
      )} kg (${(effectiveProfile.binderFrac * 100).toFixed(
        1
      )}% of batch).`
    );
  }

  /** @type {SausageBatchPlan} */
  const plan = {
    id: batchId,
    ratioProfile: effectiveProfile,
    batchKg: round2(batchKg),
    leanKg,
    fatKg,
    saltKg,
    seasoningKg,
    liquidKg,
    binderKg,
    estPackCount,
    notes,
    swapOptions,
    chosenSwapId: chosen ? chosen.id : null,
    meta: {
      baseProfileId: baseProfile.id,
      createdAt: new Date(nowTs).toISOString(),
      species,
      style: effectiveProfile.style,
    },
  };

  emit("animals.sausage.batchPlan.built", eventSource, {
    batchId: plan.id,
    species,
    style: effectiveProfile.style,
    batchKg: plan.batchKg,
  });

  // Fire-and-forget Hub export.
  exportSausagePlanToHub(plan, eventSource).catch(() => {});

  return plan;
}

/**
 * Convenience helper:
 * Build a sausage batch plan and persist to Dexie if a sausageBatches table exists.
 *
 * Dexie expectation:
 *   db.sausageBatches: { id, ratioProfile, batchKg, ... }
 *
 * @param {string|{species?: string}} speciesInput
 * @param {number} batchKg
 * @param {SausageBatchOptions} [options]
 * @returns {Promise<SausageBatchPlan>}
 */
export async function planAndStoreSausageBatch(
  speciesInput,
  batchKg,
  options = {}
) {
  const plan = await planSausageBatch(speciesInput, batchKg, options);

  if (db && db.sausageBatches && db.sausageBatches.put) {
    try {
      await db.sausageBatches.put(plan);
      emit(
        "animals.sausage.batchPlan.stored",
        options.eventSource || "animals",
        {
          batchId: plan.id,
          species: plan.ratioProfile.species,
          style: plan.ratioProfile.style,
        }
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[animals/sausageRatios] Failed to store sausage batch in Dexie:",
        err
      );
    }
  }

  return plan;
}
