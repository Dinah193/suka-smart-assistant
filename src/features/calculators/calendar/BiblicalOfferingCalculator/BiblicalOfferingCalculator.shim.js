// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\BiblicalOfferingCalculator\BiblicalOfferingCalculator.shim.js

/**
 * BiblicalOfferingCalculator Shim
 *
 * How this fits:
 * - This shim turns a simple "what offering are we studying?" input
 *   into a rich, structured output for SSA:
 *     • canonical summary (name, scriptures, explanation)
 *     • animal patterns (species, age, sex, defect rules)
 *     • grain/drink patterns
 *     • study prompts for household / curriculum use
 * - It can be called directly by the Planning Graph / Reasoner layer.
 * - It emits a calculator event to the SSA eventBus, and optionally
 *   exports a packet to the Hub when familyFundMode is enabled.
 *
 * IMPORTANT:
 * - This file does **no** DOM work; it is pure logic.
 * - UI is handled by BiblicalOfferingCalculator.view.jsx.
 */

import { emit as emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/**
 * @typedef {Object} BiblicalOfferingCalculatorInput
 * @property {string} offeringType
 *   One of:
 *   "burnt" | "peace" | "sin" | "guilt" | "grain" | "drink"
 *   | "votive" | "freewill" | "purification" | "ordination"
 * @property {string[]} scriptureRefs
 *   Chapter/verse references anchoring this offering.
 * @property {boolean} [includeAnimals]
 * @property {boolean} [includeGrainDrink]
 * @property {"study-only"|"storytelling"|"curriculum"|"household-ritual"} [householdContext]
 */

/**
 * @typedef {Object} BiblicalOfferingCanonicalSummary
 * @property {string} label
 * @property {string[]} coreScriptures
 * @property {string} briefExplanation
 */

/**
 * @typedef {Object} BiblicalOfferingAnimalPattern
 * @property {"bull"|"ram"|"goat"|"lamb"|"turtledove"|"pigeon"|"other"} species
 * @property {string} agePattern
 * @property {"male-only"|"female-only"|"either"|"not-specified"} sexPattern
 * @property {string} defectRule
 */

/**
 * @typedef {Object} BiblicalOfferingGrainDrinkPattern
 * @property {"grain"|"oil"|"wine"|"salt"|"frankincense"|"other"} elementType
 * @property {string} details
 */

/**
 * @typedef {Object} BiblicalOfferingStudyPrompt
 * @property {string} question
 * @property {"atonement"|"thanksgiving"|"fellowship"|"holiness"|"priesthood"|"covenant"|"other"} focus
 */

/**
 * @typedef {Object} BiblicalOfferingCalculatorOutput
 * @property {BiblicalOfferingCanonicalSummary} canonicalSummary
 * @property {BiblicalOfferingAnimalPattern[]} animalPatterns
 * @property {BiblicalOfferingGrainDrinkPattern[]} grainDrinkPatterns
 * @property {BiblicalOfferingStudyPrompt[]} studyPrompts
 */

/**
 * @typedef {Object} BiblicalOfferingShimRequest
 * @property {string} calculatorId
 *   Stable ID for this calculator node in the Planning Graph.
 * @property {string} [nodeKey]
 *   Optional override for the node key; defaults to "biblical-offering-calculator".
 * @property {BiblicalOfferingCalculatorInput} input
 * @property {Record<string,unknown>} [context]
 *   Optional Planning Graph context (calendar year, feast alignment, etc.).
 */

/**
 * @typedef {Object} BiblicalOfferingShimResponse
 * @property {boolean} ok
 * @property {BiblicalOfferingCalculatorOutput} [output]
 * @property {string} [error]
 * @property {{ nodeKey: string, calculatorId: string }} [meta]
 */

// ---------------------------------------------------------------------------
// Offering templates (plain JS so it’s easy to extend later)
// ---------------------------------------------------------------------------

/** @type {Record<string, BiblicalOfferingCanonicalSummary>} */
const CANONICAL_SUMMARY_BY_TYPE = {
  burnt: {
    label: "Burnt Offering (Olah)",
    coreScriptures: ["Leviticus 1", "Leviticus 6:8–13"],
    briefExplanation:
      "Whole offering that ascends in smoke; emphasizes total devotion and atonement, with the entire animal given to YHWH.",
  },
  peace: {
    label: "Peace/Fellowship Offering (Zevach Shelamim)",
    coreScriptures: ["Leviticus 3", "Leviticus 7:11–34"],
    briefExplanation:
      "Shared meal offering emphasizing thanksgiving, fellowship, and wholeness between YHWH and His people.",
  },
  sin: {
    label: "Sin Offering (Chatat)",
    coreScriptures: ["Leviticus 4", "Leviticus 6:24–30"],
    briefExplanation:
      "Offering dealing with specific sins and purification from uncleanness, especially for leaders and community.",
  },
  guilt: {
    label: "Guilt/Trespass Offering (Asham)",
    coreScriptures: ["Leviticus 5:14–19", "Leviticus 7:1–10"],
    briefExplanation:
      "Offering tied to guilt, restitution, and breach of trust; highlights paying back plus a fifth.",
  },
  grain: {
    label: "Grain/Meal Offering (Minchah)",
    coreScriptures: ["Leviticus 2", "Leviticus 6:14–23"],
    briefExplanation:
      "Offering of fine flour, oil, and frankincense; often accompanies other offerings and highlights daily provision.",
  },
  drink: {
    label: "Drink Offering",
    coreScriptures: ["Numbers 15:1–10", "Exodus 29:40–41"],
    briefExplanation:
      "Wine poured out before YHWH, usually alongside burnt and grain offerings; visually symbolizes poured-out devotion.",
  },
  votive: {
    label: "Votive / Vow Offering",
    coreScriptures: ["Leviticus 7:16", "Numbers 6"],
    briefExplanation:
      "Offering associated with vows and promises made to YHWH; emphasizes integrity and fulfilling one’s word.",
  },
  freewill: {
    label: "Freewill Offering",
    coreScriptures: ["Leviticus 7:16", "Leviticus 22:17–25"],
    briefExplanation:
      "Voluntary offering given out of gratitude and generosity; not commanded but invited.",
  },
  purification: {
    label: "Purification / Cleansing Offering",
    coreScriptures: ["Leviticus 12", "Leviticus 14–15"],
    briefExplanation:
      "Offerings associated with purification after childbirth, skin issues, and other ritual uncleanness.",
  },
  ordination: {
    label: "Ordination / Consecration Offering",
    coreScriptures: ["Exodus 29", "Leviticus 8–9"],
    briefExplanation:
      "Offerings focusing on setting apart priests and their service; emphasizes the seriousness of approaching YHWH.",
  },
};

/** @type {Record<string, BiblicalOfferingAnimalPattern[]>} */
const ANIMAL_PATTERNS_BY_TYPE = {
  burnt: [
    {
      species: "bull",
      agePattern: "young bull",
      sexPattern: "male-only",
      defectRule: "Without blemish; whole animal burned on the altar.",
    },
    {
      species: "ram",
      agePattern: "adult ram",
      sexPattern: "male-only",
      defectRule: "Without blemish; whole animal burned on the altar.",
    },
    {
      species: "goat",
      agePattern: "adult or young goat",
      sexPattern: "either",
      defectRule: "Without blemish; scaled by the worshiper’s means.",
    },
    {
      species: "lamb",
      agePattern: "one year old",
      sexPattern: "male-only",
      defectRule: "Without blemish; often used for daily offerings.",
    },
    {
      species: "turtledove",
      agePattern: "mature turtledove",
      sexPattern: "not-specified",
      defectRule: "For those who cannot afford larger animals.",
    },
    {
      species: "pigeon",
      agePattern: "young pigeon",
      sexPattern: "not-specified",
      defectRule: "For those who cannot afford larger animals.",
    },
  ],
  peace: [
    {
      species: "bull",
      agePattern: "mature bull",
      sexPattern: "either",
      defectRule:
        "Without blemish; fat and certain organs burned, rest shared as meal.",
    },
    {
      species: "ram",
      agePattern: "mature ram",
      sexPattern: "either",
      defectRule: "Without blemish; portions for altar, priest, and worshiper.",
    },
    {
      species: "goat",
      agePattern: "mature goat",
      sexPattern: "either",
      defectRule: "Without blemish; shared meal emphasizing fellowship.",
    },
  ],
  sin: [
    {
      species: "bull",
      agePattern: "young bull",
      sexPattern: "male-only",
      defectRule:
        "For priest or whole community sin; blood used inside sanctuary as specified.",
    },
    {
      species: "goat",
      agePattern: "female goat",
      sexPattern: "female-only",
      defectRule: "Common for leader or individual; defect-free.",
    },
    {
      species: "lamb",
      agePattern: "female lamb",
      sexPattern: "female-only",
      defectRule: "Alternative to goat; defect-free.",
    },
    {
      species: "turtledove",
      agePattern: "mature turtledove",
      sexPattern: "not-specified",
      defectRule: "For those of lesser means.",
    },
    {
      species: "pigeon",
      agePattern: "young pigeon",
      sexPattern: "not-specified",
      defectRule: "For those of lesser means.",
    },
  ],
  guilt: [
    {
      species: "ram",
      agePattern: "mature ram",
      sexPattern: "male-only",
      defectRule:
        "Without blemish; associated with restitution and added fifth.",
    },
  ],
  grain: [],
  drink: [],
  votive: [],
  freewill: [],
  purification: [],
  ordination: [],
};

/** @type {Record<string, BiblicalOfferingGrainDrinkPattern[]>} */
const GRAIN_DRINK_PATTERNS_BY_TYPE = {
  burnt: [
    {
      elementType: "grain",
      details:
        "Fine flour mixed with oil, often accompanying the burnt offering.",
    },
    {
      elementType: "wine",
      details:
        "Drink offerings of wine poured out beside the altar (Numbers 15:1–10).",
    },
  ],
  peace: [
    {
      elementType: "grain",
      details:
        "Unleavened cakes and wafers with oil; also leavened bread in some peace offerings.",
    },
  ],
  sin: [],
  guilt: [],
  grain: [
    {
      elementType: "grain",
      details:
        "Fine flour, sometimes baked, sometimes presented raw; a memorial portion burned on the altar.",
    },
    {
      elementType: "oil",
      details: "Mixed into the flour or applied to baked portions.",
    },
    {
      elementType: "frankincense",
      details: "Placed on top; memorial portion burned with the grain.",
    },
    {
      elementType: "salt",
      details: "Covenant of salt; all offerings seasoned with salt.",
    },
  ],
  drink: [
    {
      elementType: "wine",
      details:
        "Wine poured out to YHWH; quantities scaled with the size of the accompanying animal.",
    },
  ],
  votive: [],
  freewill: [],
  purification: [],
  ordination: [
    {
      elementType: "grain",
      details:
        "Ordination offerings include unleavened cakes, wafers, and oil with the animals.",
    },
  ],
};

/** @type {Record<string, BiblicalOfferingStudyPrompt[]>} */
const STUDY_PROMPTS_BY_TYPE = {
  burnt: [
    {
      question:
        "What does a whole burnt offering teach about total devotion and holding nothing back from YHWH?",
      focus: "holiness",
    },
    {
      question:
        "How does smoke 'ascending' connect with the idea of prayer and a life lifted up?",
      focus: "covenant",
    },
  ],
  peace: [
    {
      question:
        "How does sharing a meal in the peace offering picture fellowship with YHWH and with one another?",
      focus: "fellowship",
    },
    {
      question:
        "In what ways can our homes mirror the gratitude of a peace offering today?",
      focus: "thanksgiving",
    },
  ],
  sin: [
    {
      question:
        "Why are different animals specified for priest, leader, and common people in sin offerings?",
      focus: "atonement",
    },
    {
      question:
        "How do sin offerings highlight both personal responsibility and YHWH’s mercy?",
      focus: "holiness",
    },
  ],
  guilt: [
    {
      question:
        "What does adding a fifth to restitution teach about repairing relationships and breaches of trust?",
      focus: "atonement",
    },
  ],
  grain: [
    {
      question:
        "How does bringing grain, oil, and frankincense reflect daily labor and dependence on YHWH’s provision?",
      focus: "thanksgiving",
    },
  ],
  drink: [
    {
      question:
        "How might a poured-out drink offering foreshadow a life poured out in service?",
      focus: "priesthood",
    },
  ],
  votive: [
    {
      question:
        "What warnings and encouragements do we see in Scripture about making and keeping vows?",
      focus: "covenant",
    },
  ],
  freewill: [
    {
      question:
        "How do freewill offerings reveal the heart behind obedience, beyond commandment alone?",
      focus: "thanksgiving",
    },
  ],
  purification: [
    {
      question:
        "What do purification offerings teach about the difference between moral guilt and ritual uncleanness?",
      focus: "holiness",
    },
  ],
  ordination: [
    {
      question:
        "Why is the priestly ordination process so detailed and costly, and what does that say about drawing near to YHWH?",
      focus: "priesthood",
    },
  ],
};

// ---------------------------------------------------------------------------
// Core shim implementation
// ---------------------------------------------------------------------------

/**
 * Main entry point for the Biblical Offering Calculator shim.
 *
 * @param {BiblicalOfferingShimRequest} request
 * @returns {Promise<BiblicalOfferingShimResponse>}
 */
export async function runBiblicalOfferingCalculatorShim(request) {
  const safeNodeKey = request.nodeKey || "biblical-offering-calculator";

  // Defensive input checks
  if (!request || typeof request !== "object") {
    return { ok: false, error: "Invalid request: expected an object." };
  }
  if (!request.calculatorId) {
    return { ok: false, error: "Missing calculatorId in request." };
  }
  const input = request.input;
  if (!input || typeof input !== "object") {
    return {
      ok: false,
      error: "Missing or invalid input for BiblicalOfferingCalculator.",
    };
  }

  const {
    offeringType,
    scriptureRefs = [],
    includeAnimals = true,
    includeGrainDrink = true,
    householdContext = "study-only",
  } = input;

  if (!offeringType || typeof offeringType !== "string") {
    return {
      ok: false,
      error: "offeringType is required and must be a string.",
    };
  }

  const lowerType = offeringType.toLowerCase();

  // Build canonical summary
  const summaryTemplate = CANONICAL_SUMMARY_BY_TYPE[lowerType] || {
    label: `Offering: ${offeringType}`,
    coreScriptures: [],
    briefExplanation:
      "Offering type not in the primary template set. Use scripture references for detailed study.",
  };

  /** @type {BiblicalOfferingCanonicalSummary} */
  const canonicalSummary = {
    label: summaryTemplate.label,
    coreScriptures:
      scriptureRefs && scriptureRefs.length > 0
        ? scriptureRefs
        : summaryTemplate.coreScriptures,
    briefExplanation: summaryTemplate.briefExplanation,
  };

  // Build animal patterns
  const animalTemplates = includeAnimals
    ? ANIMAL_PATTERNS_BY_TYPE[lowerType] || []
    : [];

  /** @type {BiblicalOfferingAnimalPattern[]} */
  const animalPatterns = animalTemplates.map((a) => ({
    species: a.species,
    agePattern: a.agePattern,
    sexPattern: a.sexPattern,
    defectRule: a.defectRule,
  }));

  // Build grain/drink patterns
  const grainTemplates = includeGrainDrink
    ? GRAIN_DRINK_PATTERNS_BY_TYPE[lowerType] || []
    : [];

  /** @type {BiblicalOfferingGrainDrinkPattern[]} */
  const grainDrinkPatterns = grainTemplates.map((g) => ({
    elementType: g.elementType,
    details: g.details,
  }));

  // Build study prompts and adapt slightly to household context
  const basePrompts = STUDY_PROMPTS_BY_TYPE[lowerType] || [];

  /** @type {BiblicalOfferingStudyPrompt[]} */
  const studyPrompts = basePrompts.map((p) => ({
    question: adaptPromptForContext(p.question, householdContext),
    focus: p.focus,
  }));

  /** @type {BiblicalOfferingCalculatorOutput} */
  const output = {
    canonicalSummary,
    animalPatterns,
    grainDrinkPatterns,
    studyPrompts,
  };

  const response = {
    ok: true,
    output,
    meta: {
      nodeKey: safeNodeKey,
      calculatorId: request.calculatorId,
    },
  };

  // Emit calculator event into SSA event bus
  emitCalculatorEvent({
    nodeKey: safeNodeKey,
    calculatorId: request.calculatorId,
    input,
    output,
  });

  // Optional Hub export
  await exportToHubIfEnabled({
    nodeKey: safeNodeKey,
    calculatorId: request.calculatorId,
    input,
    output,
    context: request.context || {},
  });

  return response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Light adaptation of study questions based on household context.
 *
 * @param {string} question
 * @param {"study-only"|"storytelling"|"curriculum"|"household-ritual"} context
 * @returns {string}
 */
function adaptPromptForContext(question, context) {
  switch (context) {
    case "storytelling":
      return `${question} How could you retell this with examples or stories in your home?`;
    case "curriculum":
      return `${question} What activity or assignment could students do with this?`;
    case "household-ritual":
      return `${question} Is there a simple, respectful way to remember this in your household rhythm (meals, readings, or songs)?`;
    case "study-only":
    default:
      return question;
  }
}

/**
 * Emit a consistent calculator event to the SSA event bus.
 *
 * @param {{
 *  nodeKey: string;
 *  calculatorId: string;
 *  input: BiblicalOfferingCalculatorInput;
 *  output: BiblicalOfferingCalculatorOutput;
 * }} payload
 */
function emitCalculatorEvent(payload) {
  try {
    emitEvent({
      type: "calculator.biblicalOffering.calculated",
      ts: new Date().toISOString(),
      source: "calculators/calendar/BiblicalOfferingCalculator",
      data: {
        nodeKey: payload.nodeKey,
        calculatorId: payload.calculatorId,
        input: payload.input,
        output: payload.output,
      },
    });
  } catch (err) {
    // Fail silently but noisily in dev
    /* eslint-disable no-console */
    console.warn(
      "[BiblicalOfferingCalculator] Failed to emit calculator event:",
      err
    );
    /* eslint-enable no-console */
  }
}

/**
 * Optional Hub export if familyFundMode === true.
 *
 * @param {{
 *  nodeKey: string;
 *  calculatorId: string;
 *  input: BiblicalOfferingCalculatorInput;
 *  output: BiblicalOfferingCalculatorOutput;
 *  context: Record<string, unknown>;
 * }} payload
 */
async function exportToHubIfEnabled(payload) {
  if (!familyFundMode) return;

  try {
    const envelope =
      typeof HubPacketFormatter?.fromCalculatorNode === "function"
        ? HubPacketFormatter.fromCalculatorNode({
            nodeKey: payload.nodeKey,
            calculatorId: payload.calculatorId,
            kind: "calculator-node",
            input: payload.input,
            output: payload.output,
            context: payload.context,
          })
        : {
            kind: "calculator-node",
            nodeKey: payload.nodeKey,
            calculatorId: payload.calculatorId,
            input: payload.input,
            output: payload.output,
            context: payload.context,
            createdAt: new Date().toISOString(),
          };

    if (typeof FamilyFundConnector?.enqueue === "function") {
      await FamilyFundConnector.enqueue(envelope);
    }

    emitEvent({
      type: "session.exported",
      ts: new Date().toISOString(),
      source: "calculators/calendar/BiblicalOfferingCalculator",
      data: {
        nodeKey: payload.nodeKey,
        calculatorId: payload.calculatorId,
        transport: "hub",
        status: "queued",
      },
    });
  } catch (err) {
    // Hub export is explicitly allowed to fail silently
    /* eslint-disable no-console */
    console.warn(
      "[BiblicalOfferingCalculator] Hub export failed (non-fatal):",
      err
    );
    /* eslint-enable no-console */
  }
}
