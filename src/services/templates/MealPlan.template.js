// src/services/templates/MealPlan.template.js
//
// Meal Plan Template (Flavor-Rhythm Aware)
// ----------------------------------------
// - Reads vision.weeklyFlavorRhythm (gregorian | hebrew | creation keys).
// - For each plan[day], injects day-specific flavor tags/notes so the model
//   preferentially selects matching recipes (e.g., “Caribbean Wednesday”).
// - Preserves recent additions: Soul-Food palette and home crafts
//   (wine / sausage / ferments / non-pork bacon) as preferences + opportunities.
// - Works with array or object plan shapes, and with Mon–Sun or Yom Rishon…Shabbat.
//
// Exports:
//   default: template object consumed by your automation runtime
//     - id, version, kind
//     - build({ vision, plan, pantry, inventory, calendar, constraints, goals })
//       -> { system, user, context }
//

/* -------------------------------- Calendars -------------------------------- */
const CAL_GREG = "gregorian";
const CAL_HEB = "hebrew";
const CAL_CRE = "creation";

const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const HEB_KEYS  = ["yom_rishon","yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat"];
const CRE_KEYS  = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];

const LABELS = {
  [CAL_GREG]: {
    monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
    thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
  },
  [CAL_HEB]: {
    yom_rishon: "Yom Rishon (Sun)", yom_sheni: "Yom Sheni (Mon)", yom_shelishi: "Yom Shelishi (Tue)",
    yom_revi_i: "Yom Revi’i (Wed)", yom_chamishi: "Yom Chamishi (Thu)", yom_shishi: "Yom Shishi (Fri)", shabbat: "Shabbat (Sat)",
  },
  [CAL_CRE]: {
    day_one: "Day One", day_two: "Day Two", day_three: "Day Three",
    day_four: "Day Four", day_five: "Day Five", day_six: "Day Six", sabbath: "Sabbath",
  },
};

const POS = {
  [CAL_GREG]: GREG_KEYS,     // Mon .. Sun
  [CAL_HEB]:  HEB_KEYS,      // Sun .. Sat
  [CAL_CRE]:  CRE_KEYS,      // Day1 .. Sabbath
};

function detectCalendar(map = {}) {
  const has = (ks) => ks.some((k) => Array.isArray(map[k]));
  if (has(HEB_KEYS)) return CAL_HEB;
  if (has(CRE_KEYS)) return CAL_CRE;
  return CAL_GREG;
}

function normalizeTo(calendar, srcMap = {}) {
  // Ensure all day keys exist for the chosen calendar, with arrays
  const out = {};
  POS[calendar].forEach((k) => { out[k] = Array.isArray(srcMap[k]) ? [...srcMap[k]] : []; });
  return out;
}

function convertCalendar(srcMap = {}, srcCal, dstCal) {
  const out = {};
  const srcKeys = POS[srcCal];
  const dstKeys = POS[dstCal];
  for (let i = 0; i < 7; i++) {
    const sk = srcKeys[i];
    const dk = dstKeys[i];
    out[dk] = Array.isArray(srcMap[sk]) ? [...srcMap[sk]] : [];
  }
  return out;
}

/* ------------------------------- Flavor Seeds ------------------------------ */
// Keep + expand your Soul-Food forward palette and craft opportunities.
const SOUL_FOOD_PALETTE = [
  "Soul Food", "Caribbean", "West African", "Cajun", "Creole",
  "BBQ", "Herb-Garlic", "Citrus-Chili", "Garden-Fresh", "Pantry-First",
];

const CRAFT_OPPORTUNITIES = [
  // These are not meals by themselves, but cues to include workflows & pairings.
  "Home sausage (beef/lamb/poultry; no pork)",
  "Non-pork bacon (beef/lamb/turkey)",
  "Ferments & pickles (kraut, kimchi-style, pepper mash)",
  "Winemaking / small-batch musts",
];

/* ------------------------------ Day Resolution ----------------------------- */
/**
 * Given a plan "day" identifier (e.g., "Wednesday", "yom_revi_i", "day_four"),
 * return { cal: <calendar>, key: <internal day key>, label: humanLabel }.
 */
function resolveDayIdentity(dayId) {
  if (!dayId) return { cal: CAL_GREG, key: "monday", label: "Monday" };

  const id = String(dayId).trim().toLowerCase();

  // Accept common English names too:
  const englishToGreg = {
    mon: "monday", monday: "monday",
    tue: "tuesday", tues: "tuesday", tuesday: "tuesday",
    wed: "wednesday", weds: "wednesday", wednesday: "wednesday",
    thu: "thursday", thur: "thursday", thurs: "thursday", thursday: "thursday",
    fri: "friday", friday: "friday",
    sat: "saturday", saturday: "saturday",
    sun: "sunday", sunday: "sunday",
  };

  if (englishToGreg[id]) {
    const key = englishToGreg[id];
    return { cal: CAL_GREG, key, label: LABELS[CAL_GREG][key] };
  }

  if (HEB_KEYS.includes(id)) {
    return { cal: CAL_HEB, key: id, label: LABELS[CAL_HEB][id] };
  }
  if (CRE_KEYS.includes(id)) {
    return { cal: CAL_CRE, key: id, label: LABELS[CAL_CRE][id] };
  }

  // Fallback: try partial matches (e.g., "revi" → yom_revi_i)
  if (id.includes("revi"))   return { cal: CAL_HEB, key: "yom_revi_i", label: LABELS[CAL_HEB]["yom_revi_i"] };
  if (id.includes("shishi")) return { cal: CAL_HEB, key: "yom_shishi", label: LABELS[CAL_HEB]["yom_shishi"] };
  if (id.includes("rishon")) return { cal: CAL_HEB, key: "yom_rishon", label: LABELS[CAL_HEB]["yom_rishon"] };
  if (id.includes("sheni"))  return { cal: CAL_HEB, key: "yom_sheni", label: LABELS[CAL_HEB]["yom_sheni"] };
  if (id.includes("shelishi")) return { cal: CAL_HEB, key: "yom_shelishi", label: LABELS[CAL_HEB]["yom_shelishi"] };
  if (id.includes("chamishi")) return { cal: CAL_HEB, key: "yom_chamishi", label: LABELS[CAL_HEB]["yom_chamishi"] };
  if (id.includes("shabbat"))  return { cal: CAL_HEB, key: "shabbat", label: LABELS[CAL_HEB]["shabbat"] };

  if (id.includes("day_one"))  return { cal: CAL_CRE, key: "day_one",  label: LABELS[CAL_CRE]["day_one"] };
  if (id.includes("day_two"))  return { cal: CAL_CRE, key: "day_two",  label: LABELS[CAL_CRE]["day_two"] };
  if (id.includes("day_three"))return { cal: CAL_CRE, key: "day_three",label: LABELS[CAL_CRE]["day_three"] };
  if (id.includes("day_four")) return { cal: CAL_CRE, key: "day_four", label: LABELS[CAL_CRE]["day_four"] };
  if (id.includes("day_five")) return { cal: CAL_CRE, key: "day_five", label: LABELS[CAL_CRE]["day_five"] };
  if (id.includes("day_six"))  return { cal: CAL_CRE, key: "day_six",  label: LABELS[CAL_CRE]["day_six"] };
  if (id.includes("sabbath"))  return { cal: CAL_CRE, key: "sabbath",  label: LABELS[CAL_CRE]["sabbath"] };

  // Last resort
  return { cal: CAL_GREG, key: "monday", label: "Monday" };
}

/* ------------------------ Flavor Rhythm Extraction ------------------------- */
function getGregorianRhythm(vision = {}) {
  const r = vision?.weeklyFlavorRhythm || {};
  const srcCal = detectCalendar(r);
  const norm = normalizeTo(srcCal, r);
  // Convert to Gregorian for consistent day-name matching (“Wednesday”, etc.)
  return srcCal === CAL_GREG ? norm : convertCalendar(norm, srcCal, CAL_GREG);
}

function flavorsForDay(vision, dayId) {
  const greg = getGregorianRhythm(vision);
  const rid = resolveDayIdentity(dayId);
  // Map day to Gregorian index to pull matching flavors regardless of input calendar
  const mapToGreg = {
    [CAL_GREG]: GREG_KEYS,
    [CAL_HEB]:  ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"], // position aligned
    [CAL_CRE]:  ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"], // position aligned
  };
  const idxInCal = POS[rid.cal].indexOf(rid.key);
  const gregKey = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"][idxInCal === -1 ? 0 : (idxInCal + 6) % 7] // align: CAL_HEB starts Sun
    || "monday";

  const dayFlavors = Array.isArray(greg[gregKey]) ? greg[gregKey] : [];
  return dayFlavors.filter(Boolean);
}

/* ------------------------------ Prompt Builders ---------------------------- */
function buildDayNote(vision, dayId) {
  const rid = resolveDayIdentity(dayId);
  const flavors = flavorsForDay(vision, dayId);
  if (!flavors.length) return `${rid.label}: no specific flavor rhythm — choose family-friendly, time-appropriate recipes.`;
  if (flavors.length === 1) return `${rid.label}: ${flavors[0]} focus. Prefer recipes that genuinely fit this flavor profile.`;
  return `${rid.label}: flavor mix = ${flavors.join(", ")}. Prefer recipes that fit these profiles (or harmonious fusions).`;
}

function buildGlobalPreferences(vision = {}) {
  const dietary = (vision.dietary || []).map(String);
  const constraints = (vision.constraints || []).map(String);

  const noPork = dietary.some((d) => /no pork|torah|halal/i.test(d)) || constraints.some((c) => /no pork/i.test(c));
  const halalish = dietary.some((d) => /halal/i.test(d));
  const torah = dietary.some((d) => /torah/i.test(d));

  const craftLines = [
    `If planning batch/prep workflows, include periodic **craft opportunities** (optional side-tasks) such as: ${CRAFT_OPPORTUNITIES.join("; ")}.`,
    noPork
      ? "Use **non-pork** options for bacon/sausage; default to beef, lamb, or turkey. Absolutely avoid pork ingredients."
      : "If bacon/sausage appear, you may use beef, lamb, turkey, or (only if allowed) pork.",
  ];

  const soulPaletteLine = `Keep a strong **Soul-Food forward palette** where appropriate: ${SOUL_FOOD_PALETTE.join(", ")}; integrate with weekly flavor rhythm.`;

  const constraintsLine = constraints.length
    ? `Household constraints to respect: ${constraints.join("; ")}.`
    : "Respect general home-kitchen constraints (cleanup time, burner/oven availability).";

  const dietaryLine = dietary.length
    ? `Dietary notes: ${dietary.join("; ")}.`
    : "No strict dietary notes provided; keep meals balanced, whole-food oriented, and budget-aware.";

  const sabbathHint =
    "For the Sabbath/Shabbat/Day Seven, prefer low-effort, pre-prepared, or reheat-friendly dishes; minimize active cooking.";

  const fullMoonHint =
    "Align to the household’s Hebrew calendar stance (full-moon month start). Seasonal rhythms may influence produce choices and celebratory dishes.";

  return [
    soulPaletteLine,
    craftLines.join(" "),
    constraintsLine,
    dietaryLine,
    sabbathHint,
    fullMoonHint,
  ].join("\n");
}

/* ----------------------------- Plan Normalizers ---------------------------- */
function listDaysFromPlan(plan) {
  if (!plan) return [];
  if (Array.isArray(plan)) {
    // Expect items like { day: "Wednesday", meals: [...] }
    return plan.map((d) => d?.day ?? "").filter(Boolean);
  }
  // Object keyed by day: { Wednesday: {...}, yom_revi_i: {...}, ... }
  return Object.keys(plan);
}

function injectNotesIntoPlan(vision, plan) {
  if (!plan) return plan;

  const applyToDayStruct = (dayStruct, dayId) => {
    const note = buildDayNote(vision, dayId);
    const flavors = flavorsForDay(vision, dayId);
    const tags = (dayStruct?.tags || []).concat(flavors.map((f) => `flavor:${f}`));
    const notes = (dayStruct?.notes || []).concat([note]);
    return { ...dayStruct, notes, tags };
  };

  if (Array.isArray(plan)) {
    return plan.map((entry) => {
      const dayId = entry?.day ?? "Monday";
      return applyToDayStruct(entry || {}, dayId);
    });
  }

  // Object shape
  const out = { ...plan };
  for (const dayId of Object.keys(plan)) {
    out[dayId] = applyToDayStruct(plan[dayId] || {}, dayId);
  }
  return out;
}

/* --------------------------------- Template -------------------------------- */
const MealPlanTemplate = {
  id: "meal-plan.v3-flavor-rhythm",
  version: "3.0.0",
  kind: "meal-plan-template",
  description: "Flavor-rhythm-aware meal plan prompt with Soul-Food palette and craft opportunities.",

  /**
   * build -> returns messages/context for your LLM runtime
   * @param {Object} args
   * @param {Object} args.vision – includes weeklyFlavorRhythm, dietary, constraints, goals, budget, weeklyHrs
   * @param {Object|Array} args.plan – draft plan shape (array of day entries or object keyed by day)
   * @param {Object} [args.pantry] – normalized pantry/inventory snapshot (optional)
   * @param {Object} [args.inventory] – additional inventory/storehouse data (optional)
   * @param {String} [args.calendar] – "gregorian" | "hebrew" | "creation" (for headings only)
   * @param {Array}  [args.goals] – explicit goals (else vision.goals used)
   * @param {Array}  [args.constraints] – explicit constraints (else vision.constraints used)
   */
  build(args = {}) {
    const {
      vision = {},
      plan = {},
      pantry = {},
      inventory = {},
      calendar = CAL_GREG,
      goals = vision.goals || [],
      constraints = vision.constraints || [],
    } = args;

    const dayIds = listDaysFromPlan(plan);
    const dayNotes = dayIds.map((d) => buildDayNote(vision, d));
    const globalPrefs = buildGlobalPreferences(vision);

    const augmentedPlan = injectNotesIntoPlan(vision, plan);

    const system = [
      "You are a household meal-planning assistant.",
      "Generate practical, tasty weekly meal plans that respect time, budget, and dietary constraints.",
      "Prefer recipes that match the day’s flavor rhythm, using the day-specific notes and tags provided per entry.",
      "Use whole ingredients; keep prep/cleanup reasonable.",
      "If craft opportunities are present, integrate them as optional side workflows that enhance future meals.",
    ].join("\n");

    const user = [
      `Calendar View: ${calendar === CAL_HEB ? "Hebrew week (Yom Rishon…Shabbat)" : calendar === CAL_CRE ? "Creation week (Day One…Sabbath)" : "Gregorian week (Mon…Sun)"}`,
      "",
      "Global preferences & constraints:",
      globalPrefs,
      "",
      goals?.length ? `Goals: ${goals.join("; ")}` : "",
      constraints?.length ? `Constraints: ${constraints.join("; ")}` : "",
      vision.weeklyHrs ? `Weekly time budget: ${typeof vision.weeklyHrs === "object" ? vision.weeklyHrs.value ?? "" : vision.weeklyHrs} hrs` : "",
      vision.budget ? `Budget target: ${typeof vision.budget === "object" ? vision.budget.value ?? "" : vision.budget} / week` : "",
      "",
      "Day-specific flavor notes (use to choose recipes):",
      ...dayNotes.map((n) => `• ${n}`),
      "",
      "Output requirements:",
      "- Return a structured weekly plan with breakfast/lunch/dinner (if applicable), batch-prep slots, and clear shopping aggregates.",
      "- Tag each day’s recipes with the applied flavor(s).",
      "- When Sabbath/Shabbat/Sabbath-equivalent day appears, prefer make-ahead or low-effort meals.",
    ].filter(Boolean).join("\n");

    // Provide the model with structured context (the augmented plan is used by your runtime or function-calls)
    const context = {
      calendar,
      weeklyFlavorRhythm: vision.weeklyFlavorRhythm || {},
      planDraft: augmentedPlan,     // already injected with day notes & flavor tags
      pantry,
      inventory,
      palettes: { soulFoodForward: SOUL_FOOD_PALETTE },
      craftOpportunities: CRAFT_OPPORTUNITIES,
    };

    return { system, user, context };
  },
};

export default MealPlanTemplate;
