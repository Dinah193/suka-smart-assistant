/**
 * src/agents/skills/cooking/composeSession.js
 *
 * How this fits:
 * - Consumes a normalized "recipe-like" object and produces a Session object that adheres
 *   to the SSA Session contract for the "cooking" domain.
 * - Adds synthesized prep steps (e.g., preheat oven, boil water) based on cues in the recipe.
 * - Computes per-step durations with defensive fallbacks and aggregates analytics scaffolding.
 * - Attaches guard "blockers" for inventory, weather, quietHours, sabbath, equipment (noisy gear),
 *   leaving actual evaluation to runtime guards in the SessionRunner.
 * - Emits nothing itself (pure creation). The caller (e.g., session creator) will persist and emit.
 *
 * Extension points:
 * - addCueExtractors(): register new cue heuristics (e.g., proofing, marinating).
 * - addGuardInferers(): register new domain guard mappings (e.g., allergy guard).
 * - addTimingHeuristics(): refine step duration estimation, parallelization hints, etc.
 */

import { emit } from "@/services/events/eventBus"; // optional use in future; not used here to keep pure
import { familyFundMode } from "@/config/featureFlags"; // not used directly here
// HubPacketFormatter/FamilyFundConnector are used at export time by the SessionRunner, not here.

/** @typedef {Object} RecipeSource
 *  @property {"recipe"} type
 *  @property {string|null} refId
 */

/** @typedef {Object} RecipeLike
 *  @property {string} id
 *  @property {string} title
 *  @property {Array<{name:string, qty?:string, unit?:string, id?:string}>} [ingredients]
 *  @property {Array<{ text:string, durationSec?:number, tempF?:number }>} [instructions]
 *  @property {Array<string>} [equipment]            // e.g., ["oven","stovetop","blender","grill"]
 *  @property {Array<{ name:string, tempF?:number }>} [temps]
 *  @property {Record<string,any>} [meta]           // free-form, may include "yield","doneness","noisy"
 *  @property {{ refUrl?:string, author?:string }} [source]
 */

/** @typedef {Object} ComposeOptions
 *  @property {RecipeSource} source
 *  @property {{voiceGuidance?:boolean,haptic?:boolean,autoAdvance?:boolean}} [prefs]
 *  @property {(name:string)=>boolean} [inventoryHas] // returns true if an ingredient is present
 *  @property {boolean} [assumeQuietHoursSensitive]   // default true
 *  @property {boolean} [assumeSabbathSensitive]      // default true
 *  @property {boolean} [assumeWeatherSensitive]      // default true
 *  @property {number}  [defaultStepDurationSec]      // default 60
 *  @property {string}  [nowIso]                      // default new Date().toISOString()
 *  @property {string}  [sessionTitle]                // optional override for session title
 *  @property {string}  [title]                       // optional override for session title
 *  @property {string}  [domainLabel]                 // optional label used to form fallback title
 */

/* ---------------------------------- Utils ---------------------------------- */

const SAFE_DEFAULT_STEP_SEC = 60;
const ISO_NOW = () => new Date().toISOString();
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/** Fallback UUID (browser crypto is preferred, but not guaranteed in SSR) */
function uuid() {
  try {
    // @ts-ignore
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  // RFC4122-ish fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; // not cryptographically secure
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function titleCase(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Normalize "instructions" into the expected shape.
 * This prevents blank step titles when callers pass:
 * - ["Step 1", "Step 2"]
 * - [{ desc: "..." }]
 * - [{ title: "...", text: undefined }]
 */
function normalizeInstructions(instructions) {
  const arr = Array.isArray(instructions) ? instructions : [];
  return arr
    .map((ins) => {
      if (typeof ins === "string") return { text: ins };
      if (ins && typeof ins === "object") {
        const text =
          typeof ins.text === "string" && ins.text.trim()
            ? ins.text
            : typeof ins.desc === "string" && ins.desc.trim()
            ? ins.desc
            : typeof ins.title === "string" && ins.title.trim()
            ? ins.title
            : "";
        const durationSec =
          typeof ins.durationSec === "number" &&
          Number.isFinite(ins.durationSec)
            ? ins.durationSec
            : undefined;
        const tempF =
          typeof ins.tempF === "number" && Number.isFinite(ins.tempF)
            ? ins.tempF
            : undefined;
        return {
          text,
          ...(durationSec != null ? { durationSec } : {}),
          ...(tempF != null ? { tempF } : {}),
        };
      }
      return { text: "" };
    })
    .filter((x) => x && typeof x.text === "string");
}

function resolveSessionTitle(recipe, options) {
  const recipeTitle =
    typeof recipe?.title === "string" ? recipe.title.trim() : "";
  if (recipeTitle) return recipeTitle;

  const optTitle =
    (typeof options?.sessionTitle === "string" &&
      options.sessionTitle.trim()) ||
    (typeof options?.title === "string" && options.title.trim()) ||
    "";
  if (optTitle) return optTitle;

  const label =
    (typeof options?.domainLabel === "string" && options.domainLabel.trim()) ||
    "";
  if (label) return `${titleCase(label)} Session`;

  return "Cooking Session";
}

/** Safely parse human-ish time fragments found in instruction text. */
function parseDurationSec(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  // "1 hr 20 min", "90 minutes", "about 5–7 min", "5 to 7 mins"
  const hrMatch = t.match(/(\d+(?:\.\d+)?)\s*(hour|hr|hrs)/);
  const minMatch = t.match(/(\d+(?:\.\d+)?)\s*(minute|min|mins)/);
  const secMatch = t.match(/(\d+(?:\.\d+)?)\s*(second|sec|secs)/);
  const rangeMatch = t.match(
    /(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)/
  );

  let total = 0;
  if (hrMatch) total += parseFloat(hrMatch[1]) * 3600;
  if (minMatch) total += parseFloat(minMatch[1]) * 60;
  if (secMatch) total += parseFloat(secMatch[1]);

  if (!hrMatch && !minMatch && !secMatch && rangeMatch) {
    // average of range in minutes if unit implied
    const avg = (parseFloat(rangeMatch[1]) + parseFloat(rangeMatch[2])) / 2;
    // guess minutes if words like "min" are nearby
    if (/min/.test(t)) total += avg * 60;
    else if (/sec/.test(t)) total += avg;
    else if (/hour|hr/.test(t)) total += avg * 3600;
    else total += avg * 60; // default to minutes
  }

  if (total > 0) return clamp(Math.round(total), 10, 8 * 3600);
  return null;
}

function extractTempF(text) {
  if (!text) return null;
  const m = text.toLowerCase().match(/(\d{2,3})\s*°?\s*f\b/);
  return m ? clamp(parseInt(m[1], 10), 80, 750) : null;
}

const NOISY_EQUIPMENT = new Set([
  "blender",
  "food processor",
  "stand mixer",
  "mixer",
  "grinder",
]);
const OUTDOOR_EQUIPMENT = new Set([
  "grill",
  "smoker",
  "open fire",
  "camp stove",
]);

/* ------------------------------ Cue Extractors ----------------------------- */
/** Pluggable cue extractors; each returns { tempTargetF?, donenessCue?, cueNotes? } */
const cueExtractors = [
  /** Probe-temp cues */
  (stepText) => {
    const t = extractTempF(stepText);
    if (t)
      return {
        tempTargetF: t,
        donenessCue: "probeTemp",
        cueNotes: `Target ${t}°F`,
      };
    if (/until.*(internal|center)\s+temp/i.test(stepText))
      return {
        donenessCue: "probeTemp",
        cueNotes: "Cook to safe internal temperature",
      };
    return null;
  },
  /** Texture/color cues */
  (stepText) => {
    if (
      /until.*(golden|brown|crisp|opaque|set|thickened|glossy)/i.test(stepText)
    ) {
      return { donenessCue: "texture", cueNotes: "Watch color/texture change" };
    }
    if (/until.*(fragrant|aroma|smell)/i.test(stepText)) {
      return { donenessCue: "smell", cueNotes: "Follow aroma development" };
    }
    return null;
  },
  /** Timer cues */
  (stepText) => {
    const d = parseDurationSec(stepText);
    if (d)
      return {
        donenessCue: "timer",
        cueNotes: `Approx. ${Math.round(d / 60)} min`,
      };
    return null;
  },
];

/** Allow external registration */
export function addCueExtractors(extractorFn) {
  if (typeof extractorFn === "function") cueExtractors.push(extractorFn);
}

/* ----------------------------- Guard Inferencers --------------------------- */
/** Return Set of guard blocker keys for a given step */
const guardInferers = [
  /** Inventory: if ingredients exist and inventoryHas provided, mark when missing */
  (ctx, step) => {
    const blockers = new Set();
    if (
      Array.isArray(ctx.ingredients) &&
      typeof ctx.inventoryHas === "function"
    ) {
      const needs = extractIngredientMentions(
        step.desc || step.title || "",
        ctx.ingredients
      );
      const missing = needs.filter((nm) => !ctx.inventoryHas(nm));
      if (missing.length) blockers.add("inventory");
    }
    return blockers;
  },
  /** Quiet hours: noisy equipment or verbs implying noise */
  (ctx, step) => {
    const blockers = new Set();
    const noisy =
      ctx.assumeQuietHoursSensitive !== false &&
      (NOISY_EQUIPMENT.has(step.metadata?.equipment || "") ||
        /\b(blend|puree|grind|beat|whip|pound|hammer)\b/i.test(
          step.desc || ""
        ));
    if (noisy) blockers.add("quietHours");
    return blockers;
  },
  /** Weather: outdoor cooking */
  (ctx, step) => {
    const blockers = new Set();
    const outdoor =
      ctx.assumeWeatherSensitive !== false &&
      (OUTDOOR_EQUIPMENT.has(step.metadata?.equipment || "") ||
        /\b(grill|outdoor|smoker|bbq)\b/i.test(step.desc || ""));
    if (outdoor) blockers.add("weather");
    return blockers;
  },
  /** Sabbath: if flagged by meta or if cooking flagged as sabbath sensitive in context */
  (ctx, _step) => {
    const blockers = new Set();
    if (ctx.assumeSabbathSensitive !== false && ctx.meta?.sabbathSensitive) {
      blockers.add("sabbath");
    }
    return blockers;
  },
  /** Equipment availability */
  (ctx, step) => {
    const blockers = new Set();
    if (
      step.metadata?.equipment &&
      !hasEquipment(ctx.equipment, step.metadata.equipment)
    ) {
      blockers.add("equipment");
    }
    return blockers;
  },
];

export function addGuardInferers(infererFn) {
  if (typeof infererFn === "function") guardInferers.push(infererFn);
}

function hasEquipment(available = [], required) {
  if (!required) return true;
  if (!Array.isArray(available)) return false;
  return available
    .map((s) => s.toLowerCase())
    .includes(String(required).toLowerCase());
}

function extractIngredientMentions(text, ingredients) {
  const t = (text || "").toLowerCase();
  return ingredients
    .map((i) => (i?.name || "").toLowerCase())
    .filter(
      (name) => name && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(t)
    );
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------------------- Timing Heuristics ---------------------------- */
const timingHeuristics = [
  // If instruction includes an explicit duration, prefer it.
  (ins) => ins.durationSec ?? parseDurationSec(ins.text) ?? null,
  // Equipment hints
  (ins, ctx) => {
    const t = ins.text?.toLowerCase() || "";
    if (/preheat/.test(t) && (ctx.temps?.length || extractTempF(t)))
      return 8 * 60; // avg 8 min
    if (/boil water|bring.*water.*boil/.test(t)) return 6 * 60; // stove warm-up
    if (/rest\b|let.*rest/.test(t)) return 5 * 60;
    if (/simmer/.test(t)) return 10 * 60;
    if (/sear|brown/.test(t)) return 3 * 60;
    return null;
  },
  // Default fallback
  (_ins, ctx) => ctx.defaultStepDurationSec ?? SAFE_DEFAULT_STEP_SEC,
];

export function addTimingHeuristics(fn) {
  if (typeof fn === "function") timingHeuristics.push(fn);
}

function estimateDurationSec(instruction, ctx) {
  for (const h of timingHeuristics) {
    const v = h(instruction, ctx);
    if (typeof v === "number" && v > 0) return clamp(v, 10, 8 * 3600);
  }
  return SAFE_DEFAULT_STEP_SEC;
}

/* --------------------------- Prep Synthesis Logic -------------------------- */

function synthesizePrepSteps(recipe) {
  /** @type {Array<{title:string, desc:string, durationSec:number, metadata:Record<string,any>}>} */
  const prep = [];

  // Oven preheat
  const declaredTemp =
    recipe.temps?.find((t) => Number.isFinite(t.tempF))?.tempF ??
    recipe.instructions?.map((i) => extractTempF(i.text)).find((v) => v) ??
    null;
  const usesOven =
    (recipe.equipment || []).some((e) => /oven/i.test(e)) ||
    recipe.instructions?.some((i) => /oven/i.test(i.text || "")) ||
    false;
  if (usesOven && declaredTemp) {
    prep.push({
      title: `Preheat oven to ${declaredTemp}°F`,
      desc: `Set oven to ${declaredTemp}°F so it's ready by the time batter/dish is prepared.`,
      durationSec: 8 * 60, // heuristic
      metadata: {
        tempTargetF: declaredTemp,
        equipment: "oven",
        donenessCue: "timer",
        cueNotes: "Preheating",
      },
    });
  }

  // Boiling water
  const needsBoil =
    recipe.instructions?.some((i) =>
      /boil (?:the )?water|bring.*water.*boil/i.test(i.text || "")
    ) || recipe.meta?.boilWater === true;
  if (needsBoil) {
    prep.push({
      title: "Start pot of water to boil",
      desc: "Fill a large pot with water and bring to a boil so it's ready on time.",
      durationSec: 6 * 60,
      metadata: {
        equipment: "stovetop",
        donenessCue: "timer",
        cueNotes: "At rolling boil",
      },
    });
  }

  // Pan preheat
  const needsSearing = recipe.instructions?.some((i) =>
    /\b(sear|brown|pan-fry|stir-fry)\b/i.test(i.text || "")
  );
  if (needsSearing) {
    prep.push({
      title: "Preheat pan",
      desc: "Place a heavy pan over medium-high heat until hot (water flick sizzles).",
      durationSec: 2 * 60,
      metadata: {
        equipment: "stovetop",
        donenessCue: "smell",
        cueNotes: "Pan hot; oil shimmers",
      },
    });
  }

  // Gear staging based on equipment list
  if (Array.isArray(recipe.equipment) && recipe.equipment.length) {
    prep.push({
      title: "Stage equipment",
      desc: `Gather equipment: ${recipe.equipment.join(", ")}`,
      durationSec: 60,
      metadata: {
        equipment: "prep",
        donenessCue: "timer",
        cueNotes: "Mise en place",
      },
    });
  }

  // Ingredient mise
  if (Array.isArray(recipe.ingredients) && recipe.ingredients.length) {
    prep.push({
      title: "Mise en place",
      desc: "Wash, measure, and prep ingredients per recipe (mince, dice, thaw).",
      durationSec: 4 * 60,
      metadata: {
        equipment: "prep",
        donenessCue: "timer",
        cueNotes: "Ingredients ready",
      },
    });
  }

  return prep;
}

/* --------------------------- Instruction -> Step --------------------------- */

function toStepFromInstruction(ins, ctx, index) {
  const id = `${ctx.sessionId || uuid()}-s${index}`;

  // Defensive: never allow empty text -> blank UI rows
  const rawText = typeof ins?.text === "string" ? ins.text : "";
  const safeText = rawText.trim() ? rawText : `Step ${index + 1}`;

  const title = summarizeInstruction(safeText);
  const durationSec = estimateDurationSec({ ...ins, text: safeText }, ctx);

  // Merge cue metadata from extractors
  const cueMeta = {};
  for (const ex of cueExtractors) {
    const m = ex(safeText || "");
    if (m && typeof m === "object") Object.assign(cueMeta, m);
  }

  // Equipment guess
  const equipment =
    guessEquipment(safeText, ctx) ||
    (Array.isArray(ctx.equipment) && ctx.equipment.length
      ? ctx.equipment[0]
      : undefined);

  /** @type {import('../../../types').SessionStep|any} */
  const step = {
    id,
    title,
    desc: safeText || title,
    durationSec,
    blockers: [],
    metadata: {
      ...(Number.isFinite(ins.tempF) ? { tempTargetF: ins.tempF } : {}),
      ...(cueMeta || {}),
      ...(equipment ? { equipment } : {}),
    },
  };

  // Attach blockers via inferers
  const blockers = new Set();
  for (const inf of guardInferers) {
    for (const b of inf(ctx, step)) blockers.add(b);
  }
  step.blockers = Array.from(blockers);
  return step;
}

function toStepFromPrep(prep, ctx, index) {
  const id = `${ctx.sessionId || uuid()}-p${index}`;
  const step = {
    id,
    title: prep.title,
    desc: prep.desc,
    durationSec: clamp(prep.durationSec || SAFE_DEFAULT_STEP_SEC, 10, 8 * 3600),
    blockers: [],
    metadata: { ...(prep.metadata || {}) },
  };
  const blockers = new Set();
  for (const inf of guardInferers) {
    for (const b of inf(ctx, step)) blockers.add(b);
  }
  step.blockers = Array.from(blockers);
  return step;
}

function summarizeInstruction(text) {
  const t = (text || "").trim();
  if (!t) return "Do the next step";
  // Shorten to imperative-ish label
  const firstSentence = t.split(/[.!?]/)[0];
  const max = 80;
  return firstSentence.length <= max
    ? firstSentence
    : `${firstSentence.slice(0, max - 1)}…`;
}

function guessEquipment(text, ctx) {
  const t = (text || "").toLowerCase();
  if (/oven|bake|roast|broil/.test(t)) return "oven";
  if (/grill|bbq|smoker/.test(t)) return "grill";
  if (/simmer|boil|pot|saucepan|stockpot/.test(t)) return "stovetop";
  if (/pan-fry|fry|skillet|pan/.test(t)) return "stovetop";
  if (/blend|puree|processor|mixer|whip|beat/.test(t)) return "blender";
  return Array.isArray(ctx.equipment) && ctx.equipment[0]
    ? ctx.equipment[0]
    : undefined;
}

/* --------------------------------- Compose -------------------------------- */

const DEFAULT_PREFS = { voiceGuidance: true, haptic: true, autoAdvance: false };

/**
 * Compose a runnable SSA Session for the cooking domain from a Recipe-like input.
 * @param {RecipeLike} recipe
 * @param {ComposeOptions} options
 * @returns {import('../../../types').Session|any}
 */
export function composeSessionFromRecipe(recipe, options = {}) {
  const errs = validateRecipe(recipe);
  if (errs.length) {
    console.warn("[composeSessionFromRecipe] Invalid recipe:", errs);
  }

  const nowIso = options.nowIso || ISO_NOW();
  const sessionId = `sess-${recipe?.id || uuid()}`;

  // ✅ Normalize instructions defensively so steps don’t render blank rows
  const normalizedInstructions = normalizeInstructions(recipe?.instructions);

  const ctx = {
    sessionId,
    equipment: recipe?.equipment || [],
    ingredients: recipe?.ingredients || [],
    temps: recipe?.temps || [],
    meta: recipe?.meta || {},
    inventoryHas: options.inventoryHas,
    assumeQuietHoursSensitive: options.assumeQuietHoursSensitive ?? true,
    assumeSabbathSensitive: options.assumeSabbathSensitive ?? true,
    assumeWeatherSensitive: options.assumeWeatherSensitive ?? true,
    defaultStepDurationSec:
      options.defaultStepDurationSec ?? SAFE_DEFAULT_STEP_SEC,
  };

  // 1) Synthesized prep
  const prepItems = synthesizePrepSteps({
    ...recipe,
    instructions: normalizedInstructions,
  });
  // 2) Instruction steps
  const instructionItems = normalizedInstructions.map((ins, i) =>
    toStepFromInstruction(ins, ctx, i)
  );

  // 3) Prepend prep steps (ensuring uniqueness by title)
  const preSteps = dedupeByTitle(
    prepItems.map((p, i) => toStepFromPrep(p, ctx, i))
  );
  const steps = [...preSteps, ...instructionItems].map((s, i) => ({
    ...s,
    id: `${sessionId}-${i + 1}`,
  }));

  // 4) Attach doneness cues from recipe meta if missing
  for (const s of steps) {
    if (!s.metadata?.donenessCue && recipe.meta?.doneness) {
      s.metadata = {
        ...(s.metadata || {}),
        donenessCue: "timer",
        cueNotes: recipe.meta.doneness,
      };
    }
  }

  // ✅ Title fix: don’t default to "Cooking Session" if caller passed a Cleaning/Generic title elsewhere.
  const sessionTitle = resolveSessionTitle(recipe, options);

  // 5) Final assembly
  /** @type {import('../../../types').Session|any} */
  const session = {
    id: sessionId,
    domain: "cooking",
    title: sessionTitle,
    source: {
      type: "recipe",
      refId: recipe?.id || options?.source?.refId || null,
    },
    steps,
    prefs: {
      ...DEFAULT_PREFS,
      ...(options?.prefs || {}),
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Final contract validation (non-throwing)
  const sessionErrs = validateSession(session);
  if (sessionErrs.length) {
    console.warn(
      "[composeSessionFromRecipe] Session contract warnings:",
      sessionErrs
    );
  }

  return session;
}

/* -------------------------------- Validators ------------------------------- */

function validateRecipe(recipe) {
  /** @type {string[]} */
  const errs = [];
  if (!recipe || typeof recipe !== "object") {
    errs.push("recipe is required object");
    return errs;
  }
  if (!recipe.title) errs.push("recipe.title missing");
  if (!Array.isArray(recipe.instructions) || recipe.instructions.length === 0) {
    errs.push("recipe.instructions missing or empty");
  }
  return errs;
}

function validateSession(session) {
  /** @type {string[]} */
  const errs = [];
  if (!session.id) errs.push("session.id missing");
  if (session.domain !== "cooking")
    errs.push("session.domain must be 'cooking'");
  if (!Array.isArray(session.steps) || !session.steps.length)
    errs.push("session.steps missing/empty");
  session.steps?.forEach((s, i) => {
    if (!s.title) errs.push(`steps[${i}].title missing`);
    if (!Number.isFinite(s.durationSec))
      errs.push(`steps[${i}].durationSec invalid`);
    if (!Array.isArray(s.blockers)) errs.push(`steps[${i}].blockers invalid`);
  });
  return errs;
}

/* --------------------------------- Helpers -------------------------------- */

function dedupeByTitle(steps) {
  const seen = new Set();
  const out = [];
  for (const s of steps) {
    const key = (s.title || "").toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/* ------------------------------- Mock Types --------------------------------
 * These JSDoc type imports help IDEs without forcing runtime deps. You may define
 * real TS types in src/agents/types.ts and replace the import path above.
 *
 * // Example minimal Session type:
 * export type Session = {
 *   id: string,
 *   domain: "cooking",
 *   title: string,
 *   source: { type: "recipe", refId: string|null },
 *   steps: Array<{
 *     id: string,
 *     title: string,
 *     desc: string,
 *     durationSec: number,
 *     blockers: Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">,
 *     metadata: { tempTargetF?:number, donenessCue?:"color"|"texture"|"probeTemp"|"timer"|"smell", cueNotes?:string, equipment?:string }
 *   }>,
 *   prefs: { voiceGuidance: boolean, haptic: boolean, autoAdvance: boolean },
 *   status: "pending"|"running"|"paused"|"completed"|"aborted",
 *   progress: { currentStepIndex:number, elapsedSec:number, startedAt:string|null, pausedAt:string|null },
 *   analytics: { skippedSteps:string[], adjustments:Array<any> },
 *   createdAt: string,
 *   updatedAt: string
 * }
 * -------------------------------------------------------------------------- */

/* --------------------------------- Exports -------------------------------- */

export default {
  composeSessionFromRecipe,
  addCueExtractors,
  addGuardInferers,
  addTimingHeuristics,
};
