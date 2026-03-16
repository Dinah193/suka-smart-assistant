/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\engines\RecipeAdapterService.js
//
// SSA • Recipe Adapter Service (Pipeline)
// -----------------------------------------------------------------------------
// Purpose:
//   Converts an imported or manually entered recipe into an SSA "persisted adapted"
//   RecipeVariant, and compiles a SessionRunner-ready CookPlan.
//
// This service is deterministic (no AI required) and supports:
//   - Doneness preference enforcement (via DonenessTargets.catalog)
//   - Tool/equipment substitution (via ToolSubstitutionRules.catalog)
//   - Kitchen capability filtering + method fallbacks
//   - Step normalization + rewrite hints from substitutions
//   - Centralized targets/timers + session-ready timeline compilation
//   - Explainability (human readable reasons + warnings)
//   - Safe defaults if input recipes are incomplete
//
// Inputs:
//   - recipe: a "raw recipe" object (imported or manual), tolerant of shape drift
//   - donenessProfile: user/household doneness preferences (optional)
//   - kitchenCaps: household kitchen capabilities (optional)
//   - options: pipeline flags
//
// Outputs:
//   {
//     ok: boolean,
//     variant: RecipeVariant,      // persisted adapted recipe
//     cookPlan: CookPlan,          // session-ready plan output
//     report: AdapterReport        // explainability + warnings
//   }
//
// Important integration notes:
//   - This file intentionally avoids importing Node-only APIs.
//   - Validation uses schema helpers if available; otherwise, it normalizes.
//
// Optional: If you have your own eventBus, emit events outside this service.
// -----------------------------------------------------------------------------
//
// Related files (expected in your repo per your previous plan):
//   contracts/
//     - recipeVariant.schema.js
//     - cookPlan.schema.js
//     - doneness.profile.schema.js
//     - kitchen.capabilities.schema.js
//   catalogs/
//     - DonenessTargets.catalog.js
//     - ToolSubstitutionRules.catalog.js
//
// -----------------------------------------------------------------------------
// API:
//   RecipeAdapterService.adaptToVariant({ recipe, householdId, userId, donenessProfile, kitchenCaps, options })
//   RecipeAdapterService.compileCookPlan({ variant, householdId, userId, donenessProfile, kitchenCaps, options })
//   RecipeAdapterService.adaptAndCompile({ recipe, householdId, userId, donenessProfile, kitchenCaps, options })
//
// -----------------------------------------------------------------------------
// SSA-style: production-ready, exhaustive defensive coding (no placeholders).

import DonenessTargetsCatalog from "@/features/recipes/catalogs/DonenessTargets.catalog";
import ToolSubstitutionRulesCatalog from "@/features/recipes/catalogs/ToolSubstitutionRules.catalog";

import {
  createDefaultCookPlan,
  normalizeCookPlan,
  estimatePlanTotals,
  findDanglingRefs,
} from "@/features/recipes/contracts/cookPlan.schema";

import {
  // These should exist per your request; if missing, this file still works
  // because we only rely on normalize/create helpers if present.
  createDefaultRecipeVariant,
  normalizeRecipeVariant,
} from "@/features/recipes/contracts/recipeVariant.schema";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const SERVICE_ID = "features/recipes/engines/RecipeAdapterService";
const ADAPTER_VERSION = "1.0.0";

const DEFAULTS = Object.freeze({
  enforceSafetyMinimum: true,
  allowMethodFallbacks: true,
  allowToolSubstitutions: true,
  allowStepTextRewrite: true,
  allowTimerInference: true,
  allowTargetInference: true,
  requireUserReviewOnMissingThermometer: true,
  requireUserReviewOnMissingCriticalEquipment: true,
  maxSteps: 250,
  maxWarnings: 100,
  maxNotesLength: 8000,
});

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
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

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const y = Math.round(x);
  if (y < min) return min;
  if (y > max) return max;
  return y;
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  return Math.round(x * 10) / 10;
}

function nowISO() {
  return new Date().toISOString();
}

function safeId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function safeString(s, max = 2000, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function normalizeKitchenCaps(kitchenCaps) {
  // Tolerant adapter: accept multiple shapes
  // expected (ideal): { tools: { [key]: boolean }, tags: [] }
  const caps = isPlainObject(kitchenCaps) ? kitchenCaps : {};
  const tools = isPlainObject(caps.tools) ? caps.tools : {};
  const tags = uniqStrings(caps.tags);

  return { tools, tags };
}

function hasTool(caps, toolKey) {
  if (!toolKey) return false;
  return !!caps?.tools?.[String(toolKey)];
}

function addWarning(report, w) {
  if (!report || !isPlainObject(report)) return;
  if (!Array.isArray(report.warnings)) report.warnings = [];
  if (
    report.warnings.length >=
    (report.limits?.maxWarnings ?? DEFAULTS.maxWarnings)
  )
    return;

  const ww = isPlainObject(w)
    ? w
    : { code: "warning", message: String(w || "Warning") };
  report.warnings.push({
    code: safeString(ww.code, 128, "warning"),
    message: safeString(ww.message, 2000, "Warning"),
    severity: ["info", "warn", "error"].includes(ww.severity)
      ? ww.severity
      : "warn",
    context: isPlainObject(ww.context) ? ww.context : {},
  });
}

function pushNote(report, note) {
  if (!report) return;
  if (!Array.isArray(report.notes)) report.notes = [];
  const n = safeString(note, DEFAULTS.maxNotesLength, "");
  if (!n) return;
  report.notes.push(n);
}

function bestMethodFromText(recipe, kitchenCaps, options) {
  // Determine a primary method from recipe metadata or instructions.
  const caps = kitchenCaps || normalizeKitchenCaps(null);
  const allowFallbacks = !!options.allowMethodFallbacks;

  const textBlobs = [];
  if (typeof recipe?.method === "string") textBlobs.push(recipe.method);
  if (typeof recipe?.cookMethod === "string") textBlobs.push(recipe.cookMethod);
  if (typeof recipe?.title === "string") textBlobs.push(recipe.title);
  if (typeof recipe?.name === "string") textBlobs.push(recipe.name);

  // Add instructions
  const steps = extractRecipeSteps(recipe);
  for (const s of steps) textBlobs.push(s);

  const blob = safeLower(textBlobs.join(" | "));

  const methodScores = new Map();
  const bump = (m, n) => methodScores.set(m, (methodScores.get(m) || 0) + n);

  // Keyword heuristics
  if (blob.includes("air fry") || blob.includes("air-fry")) bump("air_fry", 5);
  if (blob.includes("deep fry") || blob.includes("fry in oil"))
    bump("deep_fry", 5);
  if (
    blob.includes("stir-fry") ||
    blob.includes("stir fry") ||
    blob.includes("wok")
  )
    bump("stir_fry", 5);
  if (
    blob.includes("saute") ||
    blob.includes("sauté") ||
    blob.includes("skillet")
  )
    bump("saute", 3);
  if (
    blob.includes("pan-sear") ||
    blob.includes("pan sear") ||
    blob.includes("sear")
  )
    bump("pan_sear", 4);
  if (blob.includes("grill")) bump("grill", 5);
  if (blob.includes("smoke") || blob.includes("smoker")) bump("smoke", 5);
  if (blob.includes("broil")) bump("broil", 5);
  if (blob.includes("roast")) bump("roast", 4);
  if (blob.includes("bake") || blob.includes("oven")) bump("bake", 4);
  if (blob.includes("braise")) bump("braise", 4);
  if (blob.includes("stew")) bump("stew", 4);
  if (blob.includes("pressure cook") || blob.includes("instant pot"))
    bump("pressure_cook", 5);
  if (
    blob.includes("slow cooker") ||
    blob.includes("crockpot") ||
    blob.includes("crock pot")
  )
    bump("slow_cook", 5);
  if (blob.includes("sous vide")) bump("sous_vide", 6);
  if (blob.includes("microwave")) bump("microwave", 4);
  if (blob.includes("boil")) bump("boil", 3);
  if (blob.includes("simmer")) bump("simmer", 3);
  if (blob.includes("poach")) bump("poach", 3);

  // Default if nothing: bake if oven exists, else saute if stovetop exists, else no_cook
  const candidates = Array.from(methodScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0]);
  const pick = candidates[0];

  const method =
    pick ||
    (hasTool(caps, "appliance:oven")
      ? "bake"
      : hasTool(caps, "appliance:stovetop")
      ? "saute"
      : "no_cook");

  if (!allowFallbacks) return method;

  // Capability based fallback:
  return fallbackMethodIfUnavailable(method, caps);
}

function fallbackMethodIfUnavailable(method, caps) {
  // If recipe says bake but no oven, switch based on availability
  const m = safeLower(method);
  if (!m) return "no_cook";

  const ovenNeeded = ["bake", "roast", "broil"].includes(m);
  const stovetopNeeded = [
    "saute",
    "pan_sear",
    "stir_fry",
    "simmer",
    "boil",
  ].includes(m);

  if (ovenNeeded && !hasTool(caps, "appliance:oven")) {
    if (hasTool(caps, "appliance:toaster_oven"))
      return m === "broil" ? "broil" : "bake";
    if (hasTool(caps, "appliance:air_fryer")) return "air_fry";
    if (hasTool(caps, "appliance:grill")) return "grill";
    return "no_cook";
  }
  if (stovetopNeeded && !hasTool(caps, "appliance:stovetop")) {
    if (hasTool(caps, "appliance:grill")) return "grill";
    if (hasTool(caps, "appliance:microwave")) return "microwave";
    return "no_cook";
  }
  return m;
}

function extractRecipeTitle(recipe) {
  return safeString(
    recipe?.title || recipe?.name || recipe?.label,
    200,
    "Recipe"
  );
}

function extractRecipeTags(recipe) {
  const tags = []
    .concat(Array.isArray(recipe?.tags) ? recipe.tags : [])
    .concat(Array.isArray(recipe?.meta?.tags) ? recipe.meta.tags : [])
    .concat(Array.isArray(recipe?.cuisine?.tags) ? recipe.cuisine.tags : []);
  return uniqStrings(tags).map((t) => safeLower(t));
}

function extractRecipeServings(recipe) {
  // Tolerant parsing
  const v =
    recipe?.servings?.count ??
    recipe?.servings ??
    recipe?.yield ??
    recipe?.meta?.servings ??
    recipe?.meta?.yield;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return round1(n) ?? 1;
  return 4;
}

function extractRecipeSteps(recipe) {
  // Accept:
  // - recipe.steps: array strings/objects
  // - recipe.instructions: string or array
  // - recipe.directions: string or array
  // - recipe.methodSteps: array
  const steps = [];

  const pushStep = (s) => {
    if (typeof s === "string") {
      const t = s.trim();
      if (t) steps.push(t);
      return;
    }
    if (isPlainObject(s)) {
      const t = s.text || s.instruction || s.step || s.title || "";
      if (typeof t === "string" && t.trim()) steps.push(t.trim());
    }
  };

  const raw =
    recipe?.steps ??
    recipe?.instructions ??
    recipe?.directions ??
    recipe?.methodSteps ??
    recipe?.procedure ??
    null;

  if (typeof raw === "string") {
    // Split on newlines or numbered steps
    raw
      .split(/\n+/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((x) => steps.push(x));
  } else if (Array.isArray(raw)) {
    raw.forEach(pushStep);
  }

  // fallback: some imports store in recipe.text
  if (!steps.length && typeof recipe?.text === "string") {
    recipe.text
      .split(/\n+/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((x) => steps.push(x));
  }

  return steps;
}

function extractIngredients(recipe) {
  // Tolerant shape:
  //  - ingredients: array of strings or { name, amount, unit }
  //  - items: same
  const raw = recipe?.ingredients ?? recipe?.items ?? recipe?.components ?? [];
  const out = [];
  if (!Array.isArray(raw)) return out;

  for (const it of raw) {
    if (typeof it === "string") {
      const t = it.trim();
      if (!t) continue;
      out.push({ text: t });
      continue;
    }
    if (isPlainObject(it)) {
      const name = safeString(it.name || it.ingredient || it.item, 200, "");
      const amount = it.amount ?? it.qty ?? it.quantity ?? null;
      const unit = safeString(it.unit || it.uom || "", 32, "");
      const text = safeString(it.text || "", 400, "");
      const tags = uniqStrings(it.tags).map((t) => safeLower(t));
      out.push({
        name: name || undefined,
        amount: amount != null ? amount : undefined,
        unit: unit || undefined,
        text: text || undefined,
        tags: tags.length ? tags : undefined,
      });
    }
  }
  return out;
}

function inferProteinCategoryFromIngredients(ingredients, tags) {
  // SSA heuristic: look at ingredient names/tags
  const tset = new Set(uniqStrings(tags).map((t) => safeLower(t)));
  const blob = safeLower(
    ingredients
      .map((i) => i?.name || i?.text || "")
      .filter(Boolean)
      .join(" | ")
  );

  const has = (w) => blob.includes(w) || tset.has(w);

  if (
    has("chicken") ||
    has("poultry") ||
    has("drumstick") ||
    has("thigh") ||
    has("wing")
  )
    return "chicken";
  if (has("turkey")) return "turkey";
  if (has("duck")) return "duck";
  if (has("beef") || has("steak") || has("brisket")) return "beef";
  if (has("lamb")) return "lamb";
  if (has("goat")) return "goat";
  if (has("venison") || has("deer")) return "venison";
  if (has("bison")) return "bison";
  if (has("pork") || has("ham") || has("bacon")) return "pork";
  if (has("fish") || has("salmon") || has("tilapia") || has("cod"))
    return "fish";
  if (
    has("shrimp") ||
    has("crab") ||
    has("lobster") ||
    has("oyster") ||
    has("clam")
  )
    return "shellfish";
  if (has("egg") || has("eggs")) return "eggs";

  return "unknown";
}

function inferCutTagFromIngredients(ingredients, tags) {
  const tset = new Set(uniqStrings(tags).map((t) => safeLower(t)));
  const blob = safeLower(
    ingredients
      .map((i) => i?.name || i?.text || "")
      .filter(Boolean)
      .join(" | ")
  );

  const has = (w) => blob.includes(w) || tset.has(w);

  if (has("ground") || has("minced")) return "ground";
  if (has("sausage")) return "sausage";
  if (has("patty") || has("burger")) return "patty";
  if (has("steak")) return "steak";
  if (has("chop") || has("chops")) return "chops";
  if (has("roast") || has("brisket")) return "roast";
  if (has("ribs")) return "ribs";
  if (has("breast")) return "breast";
  if (has("thigh")) return "thigh";
  if (has("wing") || has("wings")) return "wings";

  return "whole";
}

function inferEquipmentFromMethod(method, stepsText, tags) {
  const m = safeLower(method);
  const blob = safeLower([...(stepsText || []), ...(tags || [])].join(" | "));

  const eq = [];

  const push = (
    key,
    label,
    klass = "appliance",
    optional = false,
    notes = ""
  ) =>
    eq.push({
      id: safeId("equip"),
      class: klass,
      key,
      label,
      optional,
      notes,
    });

  // heat sources
  if (["bake", "roast", "broil"].includes(m))
    push("appliance:oven", "Oven", "appliance", false);
  if (["air_fry"].includes(m))
    push("appliance:air_fryer", "Air Fryer", "appliance", false);
  if (["deep_fry"].includes(m))
    push("appliance:stovetop", "Stovetop", "appliance", false);
  if (["saute", "pan_sear", "stir_fry", "simmer", "boil", "poach"].includes(m))
    push("appliance:stovetop", "Stovetop", "appliance", false);
  if (["grill", "smoke"].includes(m))
    push("appliance:grill", "Grill", "appliance", false, "Outdoor cooking");
  if (["slow_cook"].includes(m))
    push("appliance:slow_cooker", "Slow Cooker", "appliance", false);
  if (["pressure_cook"].includes(m))
    push("appliance:pressure_cooker", "Pressure Cooker", "appliance", false);
  if (["sous_vide"].includes(m))
    push("appliance:sous_vide", "Sous Vide circulator", "appliance", false);
  if (["microwave"].includes(m))
    push("appliance:microwave", "Microwave", "appliance", false);

  // cookware hints
  if (["bake", "roast", "broil"].includes(m))
    push("cookware:sheet_pan", "Sheet pan", "cookware", false);
  if (blob.includes("dutch oven"))
    push("cookware:dutch_oven", "Dutch oven", "cookware", false);
  if (blob.includes("stock pot") || blob.includes("stockpot"))
    push("cookware:stock_pot", "Stock pot", "cookware", false);
  if (blob.includes("skillet"))
    push("cookware:skillet", "Skillet", "cookware", false);
  if (blob.includes("cast iron"))
    push("cookware:cast_iron_skillet", "Cast iron skillet", "cookware", true);

  // thermometer (if meat tags)
  if (
    blob.includes("chicken") ||
    blob.includes("beef") ||
    blob.includes("pork") ||
    blob.includes("lamb") ||
    blob.includes("goat") ||
    blob.includes("turkey") ||
    blob.includes("fish")
  ) {
    push(
      "utensil:instant_read_thermometer",
      "Instant-read thermometer",
      "utensil",
      true,
      "Recommended for doneness and safety."
    );
  }

  // timer always useful
  push("utensil:timer", "Timer", "utensil", true);

  // unique by key+label
  const sig = new Set();
  const out = [];
  for (const e of eq) {
    const k = `${e.key}::${e.label}`;
    if (sig.has(k)) continue;
    sig.add(k);
    out.push(e);
  }
  return out;
}

function applyStepRewriteHints(stepText, hints) {
  let out = String(stepText || "");
  let appended = "";

  for (const h of Array.isArray(hints) ? hints : []) {
    if (!isPlainObject(h)) continue;
    const findAny = uniqStrings(h.findAny);
    const replaceWith = typeof h.replaceWith === "string" ? h.replaceWith : "";
    const addNotes = typeof h.addNotes === "string" ? h.addNotes : "";

    if (findAny.length && replaceWith) {
      // Replace first occurrence of any find token (case-insensitive)
      for (const token of findAny) {
        const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "i");
        if (re.test(out)) {
          out = out.replace(re, replaceWith);
          break;
        }
      }
    }
    if (addNotes) appended += (appended ? " " : "") + addNotes.trim();
  }

  if (appended) {
    out = `${out}${out.endsWith(".") ? "" : "."} ${appended}`;
  }
  return out.trim();
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferTimersFromSteps(steps) {
  // Lightweight timer inference from phrases like "bake 20 minutes" or "rest 10 min"
  // Produces timer objects compatible with CookPlan schema helper buildTimer,
  // but we build inline because cookPlan schema already normalizes.
  const timers = [];

  const pushTimer = (label, seconds, kind, stepId) => {
    timers.push({
      id: safeId("timer"),
      label,
      seconds,
      kind,
      stepId,
      startsAfterStepId: null,
      notes: "",
    });
  };

  for (const s of steps) {
    if (!s || !s.id || typeof s.text !== "string") continue;
    const t = safeLower(s.text);

    // minutes
    const mm = t.match(/(\d+)\s*(min|mins|minute|minutes)\b/);
    const hh = t.match(/(\d+)\s*(hr|hrs|hour|hours)\b/);
    const ss = t.match(/(\d+)\s*(sec|secs|second|seconds)\b/);

    let seconds = 0;
    if (mm) seconds += Number(mm[1]) * 60;
    if (hh) seconds += Number(hh[1]) * 3600;
    if (ss) seconds += Number(ss[1]);

    if (seconds > 0) {
      let kind = "cook";
      if (t.includes("rest")) kind = "rest";
      else if (t.includes("preheat") || t.includes("prep")) kind = "prep";
      pushTimer(
        s.title || "Timer",
        clampInt(seconds, 1, 7 * 24 * 3600, 60),
        kind,
        s.id
      );
    }
  }

  return timers;
}

/* -------------------------------------------------------------------------- */
/* Adapter report                                                              */
/* -------------------------------------------------------------------------- */

function createAdapterReport(options) {
  return {
    ok: true,
    adapterVersion: ADAPTER_VERSION,
    serviceId: SERVICE_ID,
    startedAt: nowISO(),
    finishedAt: null,
    notes: [],
    warnings: [],
    decisions: [],
    limits: {
      maxWarnings: options.maxWarnings ?? DEFAULTS.maxWarnings,
    },
  };
}

function addDecision(report, decision) {
  if (!report) return;
  if (!Array.isArray(report.decisions)) report.decisions = [];
  report.decisions.push({
    at: nowISO(),
    ...decision,
  });
}

/* -------------------------------------------------------------------------- */
/* Variant building                                                            */
/* -------------------------------------------------------------------------- */

function ensureRecipeVariantHelpers() {
  // In case schema file isn't present yet, provide local minimal fallbacks.
  const hasCreate = typeof createDefaultRecipeVariant === "function";
  const hasNorm = typeof normalizeRecipeVariant === "function";

  const fallbackCreate = (args = {}) => ({
    schemaVersion: 1,
    id: args.id || safeId("variant"),
    householdId: args.householdId || "household_default",
    userId: args.userId || null,
    title: args.title || "Recipe Variant",
    tags: [],
    refs: {
      sourceRecipeId: args.sourceRecipeId || null,
      importBatchId: args.importBatchId || null,
      adapterVersion: ADAPTER_VERSION,
    },
    summary: {
      servings: { count: 4, unit: "servings" },
      methods: { primary: "bake", secondary: [] },
      time: {
        activeSeconds: 0,
        restSeconds: 0,
        totalSeconds: 0,
        confidence: 0.7,
      },
      notes: "",
    },
    ingredients: [],
    steps: [],
    equipment: { required: [], optional: [], missingAtCompileTime: [] },
    doneness: {
      proteinCategory: "unknown",
      cutTag: "whole",
      preference: null,
      targetInternalTempF: null,
      toleranceF: null,
      safetyMinimumF: null,
      wasRaisedForSafety: false,
      source: "fallback",
      ruleId: null,
    },
    substitutions: { tools: [], ingredients: [], methods: [] },
    quality: {
      needsUserReview: true,
      confidence: 0.7,
      flags: ["needs_user_review"],
      warnings: [],
    },
    meta: {
      createdAt: nowISO(),
      updatedAt: nowISO(),
      source: SERVICE_ID,
      version: 0,
    },
  });

  const fallbackNormalize = (raw) => {
    const v = isPlainObject(raw) ? deepClone(raw) : fallbackCreate();
    if (!v.schemaVersion) v.schemaVersion = 1;
    if (!v.id) v.id = safeId("variant");
    if (!v.householdId) v.householdId = "household_default";
    if (!v.title) v.title = "Recipe Variant";
    v.meta = v.meta || {};
    v.meta.updatedAt = nowISO();
    if (!v.meta.createdAt) v.meta.createdAt = nowISO();
    v.refs = v.refs || {};
    if (!v.refs.adapterVersion) v.refs.adapterVersion = ADAPTER_VERSION;
    v.tags = uniqStrings(v.tags);
    return v;
  };

  return {
    create: hasCreate ? createDefaultRecipeVariant : fallbackCreate,
    normalize: hasNorm ? normalizeRecipeVariant : fallbackNormalize,
  };
}

/* -------------------------------------------------------------------------- */
/* CookPlan compilation                                                        */
/* -------------------------------------------------------------------------- */

function compileCookPlanFromVariant(variant, kitchenCaps, options, report) {
  const caps = normalizeKitchenCaps(kitchenCaps);
  const plan = createDefaultCookPlan({
    householdId: variant.householdId,
    userId: variant.userId,
    title: variant.title,
    recipeVariantId: variant.id,
    sourceRecipeId: variant?.refs?.sourceRecipeId || null,
    adapterVersion: ADAPTER_VERSION,
  });

  // Basic refs
  plan.refs.recipeVariantId = variant.id;
  plan.refs.sourceRecipeId = variant?.refs?.sourceRecipeId || null;
  plan.refs.adapterVersion = ADAPTER_VERSION;
  plan.refs.donenessProfileId = options?.donenessProfileId || null;
  plan.refs.kitchenCapabilitiesId = options?.kitchenCapabilitiesId || null;

  // Summary
  plan.summary.servings.count =
    variant?.summary?.servings?.count ?? plan.summary.servings.count;
  plan.summary.methods.primary =
    variant?.summary?.methods?.primary ?? plan.summary.methods.primary;
  plan.summary.methods.secondary = uniqStrings(
    variant?.summary?.methods?.secondary
  );
  plan.summary.notes = safeString(variant?.summary?.notes || "", 8000, "");

  // Equipment
  plan.equipment.required = Array.isArray(variant?.equipment?.required)
    ? deepClone(variant.equipment.required)
    : [];
  plan.equipment.optional = Array.isArray(variant?.equipment?.optional)
    ? deepClone(variant.equipment.optional)
    : [];
  plan.equipment.missingAtCompileTime = Array.isArray(
    variant?.equipment?.missingAtCompileTime
  )
    ? deepClone(variant.equipment.missingAtCompileTime)
    : [];

  // Targets: include doneness target if present
  plan.targets = [];
  if (variant?.doneness?.targetInternalTempF != null) {
    plan.targets.push({
      id: safeId("target"),
      kind: "internal_temp_f",
      label: "Internal temperature",
      value: Number(variant.doneness.targetInternalTempF),
      unit: "F",
      severity: variant?.doneness?.wasRaisedForSafety ? "warn" : "info",
      source: variant?.doneness?.source || "doneness",
      notes: variant?.doneness?.ruleId
        ? `Rule: ${variant.doneness.ruleId}`
        : "",
    });
  } else if (options.allowTargetInference) {
    // still include label target
    plan.targets.push({
      id: safeId("target"),
      kind: "doneness_label",
      label: "Doneness",
      value: variant?.doneness?.preference || "target",
      unit: null,
      severity: "info",
      source: "doneness:fallback",
      notes: "",
    });
  }

  // Timeline
  const steps = Array.isArray(variant?.steps) ? variant.steps : [];
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;
  const trimmed = steps.slice(0, maxSteps);

  // In CookPlan schema, steps require (id, order, kind, title, text, estimatedSeconds, targets, timers, requires...)
  plan.timeline = trimmed.map((s, idx) => {
    const stepId = s.id || safeId("planstep");
    const text =
      typeof s.text === "string"
        ? s.text
        : typeof s.instruction === "string"
        ? s.instruction
        : "";
    const title =
      typeof s.title === "string" && s.title.trim()
        ? s.title.trim()
        : `Step ${idx + 1}`;

    // Determine step kind
    const lower = safeLower(`${title} ${text}`);
    let kind = "cook";
    if (
      lower.includes("preheat") ||
      lower.includes("prep") ||
      lower.includes("chop") ||
      lower.includes("mix")
    )
      kind = "prep";
    if (lower.includes("rest")) kind = "rest";
    if (lower.includes("serve")) kind = "serve";
    if (lower.includes("clean")) kind = "cleanup";

    return {
      id: stepId,
      order: idx + 1,
      kind,
      title: title.slice(0, 200),
      text: text.trim().slice(0, 8000) || title,
      estimatedSeconds: clampInt(s.estimatedSeconds ?? 0, 0, 7 * 24 * 3600, 0),
      targets: [], // filled later
      timers: [], // filled later
      requires: {
        equipmentIds: uniqStrings(s?.requires?.equipmentIds || []),
        methods: uniqStrings(s?.requires?.methods || []),
      },
      notes: safeString(s.notes || "", 2000, ""),
      gate: isPlainObject(s.gate)
        ? {
            required: !!s.gate.required,
            prompt: safeString(s.gate.prompt, 500, ""),
          }
        : { required: false, prompt: "" },
    };
  });

  // Link doneness target to any step that mentions temp or doneness
  const internalTempTargetId =
    plan.targets.find((t) => t.kind === "internal_temp_f")?.id || null;
  if (internalTempTargetId) {
    for (const st of plan.timeline) {
      const t = safeLower(st.text);
      if (
        t.includes("internal") ||
        t.includes("temp") ||
        t.includes("thermometer") ||
        t.includes("°f") ||
        t.includes("degrees")
      ) {
        st.targets = uniqStrings([...(st.targets || []), internalTempTargetId]);
      }
    }
    // Also add to the last step as a reminder
    const last = plan.timeline[plan.timeline.length - 1];
    if (last)
      last.targets = uniqStrings([
        ...(last.targets || []),
        internalTempTargetId,
      ]);
  }

  // Timers inference
  plan.timers = [];
  if (options.allowTimerInference) {
    const inferred = inferTimersFromSteps(
      plan.timeline.map((x) => ({ id: x.id, title: x.title, text: x.text }))
    );
    plan.timers = inferred;

    // Attach timer ids to steps
    for (const timer of inferred) {
      const step = plan.timeline.find((s) => s.id === timer.stepId);
      if (step) step.timers = uniqStrings([...(step.timers || []), timer.id]);
    }
  }

  // Checks (preflight / midflight / postflight) based on missing equipment and common needs
  plan.checks.preflight = [];
  plan.checks.midflight = [];
  plan.checks.postflight = [];

  const missingCritical = Array.isArray(
    variant?.equipment?.missingAtCompileTime
  )
    ? variant.equipment.missingAtCompileTime.filter((e) => e && !e.optional)
    : [];

  if (
    missingCritical.length &&
    options.requireUserReviewOnMissingCriticalEquipment
  ) {
    plan.quality.needsUserReview = true;
    plan.quality.flags = uniqStrings([
      ...(plan.quality.flags || []),
      "missing_critical_equipment",
      "needs_user_review",
    ]);
    addWarning(report, {
      code: "missing_critical_equipment",
      message: `Missing critical equipment: ${missingCritical
        .map((e) => e.label || e.key)
        .join(", ")}`,
      severity: "warn",
      context: { missing: missingCritical.map((e) => e.key) },
    });
  }

  // Thermometer warning if meat-ish and missing
  const needsThermo =
    (variant?.doneness?.proteinCategory &&
      variant.doneness.proteinCategory !== "unknown") ||
    extractRecipeTags(variant).includes("meat");
  const hasThermo =
    hasTool(caps, "utensil:instant_read_thermometer") ||
    hasTool(caps, "utensil:probe_thermometer");
  if (
    needsThermo &&
    !hasThermo &&
    options.requireUserReviewOnMissingThermometer
  ) {
    plan.quality.needsUserReview = true;
    plan.quality.flags = uniqStrings([
      ...(plan.quality.flags || []),
      "needs_user_review",
    ]);
    addWarning(report, {
      code: "thermometer_missing",
      message:
        "Thermometer not detected in kitchen capabilities; doneness checks may be less safe/precise.",
      severity: "warn",
      context: {
        proteinCategory: variant?.doneness?.proteinCategory || "unknown",
      },
    });
  }

  // Estimate totals
  estimatePlanTotals(plan);

  // Normalize and final reference checks
  const normalized = normalizeCookPlan(plan, { quiet: true });
  const dangling = findDanglingRefs(normalized);

  if (
    dangling.targets.length ||
    dangling.timers.length ||
    dangling.equipment.length
  ) {
    addWarning(report, {
      code: "dangling_references",
      message:
        "CookPlan contains dangling references (targets/timers/equipment).",
      severity: "warn",
      context: dangling,
    });
  }

  return normalized;
}

/* -------------------------------------------------------------------------- */
/* Variant adaptation pipeline                                                  */
/* -------------------------------------------------------------------------- */

function adaptRecipeToVariantCore({
  recipe,
  householdId,
  userId,
  donenessProfile,
  kitchenCaps,
  options,
  report,
}) {
  const caps = normalizeKitchenCaps(kitchenCaps);

  const title = extractRecipeTitle(recipe);
  const tags = extractRecipeTags(recipe);

  const servings = extractRecipeServings(recipe);
  const ingredients = extractIngredients(recipe);
  const rawSteps = extractRecipeSteps(recipe);

  const inferredProtein = inferProteinCategoryFromIngredients(
    ingredients,
    tags
  );
  const inferredCut = inferCutTagFromIngredients(ingredients, tags);

  const primaryMethodRaw = bestMethodFromText(recipe, caps, options);
  const primaryMethod = options.allowMethodFallbacks
    ? fallbackMethodIfUnavailable(primaryMethodRaw, caps)
    : primaryMethodRaw;

  // Equipment inference from steps/method
  const equipmentInferred = inferEquipmentFromMethod(
    primaryMethod,
    rawSteps,
    tags
  );

  // Apply tool substitutions if missing
  let equipmentResolved = equipmentInferred;
  let toolSubstitutions = [];
  let missingAtCompileTime = [];

  if (options.allowToolSubstitutions) {
    const subResult =
      ToolSubstitutionRulesCatalog.applyToolSubstitutionsToEquipment({
        equipmentRequired: equipmentInferred.filter((e) => !e.optional),
        kitchenCaps: caps,
        method: primaryMethod,
        recipeTags: tags,
      });

    toolSubstitutions = subResult.substitutions || [];

    // Determine missingAtCompileTime (critical)
    missingAtCompileTime = (subResult.stillMissing || []).map((key) => {
      const match = equipmentInferred.find((e) => e.key === key);
      return (
        match || {
          id: safeId("equip"),
          class: "other",
          key,
          label: key,
          optional: false,
          notes: "Missing and no substitution found.",
        }
      );
    });

    // Apply substitutions to equipment list for "required"
    const resolvedMap = new Map();
    for (const r of subResult.equipmentResolved || []) {
      if (r?.key) resolvedMap.set(r.key, r);
    }

    equipmentResolved = equipmentInferred.map((e) => {
      const r = resolvedMap.get(e.key);
      if (!r) return e;
      if (r.substituted && r.resolvedKey) {
        return {
          ...e,
          key: r.resolvedKey,
          label: e.label, // keep human label stable; UI can show substitution notes elsewhere
          notes: safeString(
            (e.notes ? `${e.notes} ` : "") + (r.substitutionNotes || ""),
            1000,
            ""
          ),
        };
      }
      return e;
    });

    if (toolSubstitutions.length) {
      addDecision(report, {
        type: "tool_substitution",
        message: `Applied ${toolSubstitutions.length} tool substitutions.`,
        context: {
          substitutions: toolSubstitutions.map((s) => ({
            missing: s.missingKey,
            chosen: s.chosenKey,
            rule: s.fromRuleId,
          })),
        },
      });
    }
    if (missingAtCompileTime.length) {
      addDecision(report, {
        type: "equipment_missing",
        message: `Missing equipment with no substitution: ${missingAtCompileTime
          .map((e) => e.key)
          .join(", ")}`,
        context: { missing: missingAtCompileTime.map((e) => e.key) },
      });
    }
  } else {
    // If no substitutions, mark missing tools
    missingAtCompileTime = equipmentInferred
      .filter((e) => !e.optional)
      .filter((e) => !hasTool(caps, e.key))
      .map((e) => ({
        ...e,
        notes: safeString(
          (e.notes ? `${e.notes} ` : "") + "Not owned.",
          1000,
          ""
        ),
      }));
  }

  // Doneness resolution
  const donenessPreference = resolveDonenessPreferenceFromProfile(
    donenessProfile,
    inferredProtein,
    inferredCut
  );
  const donenessResolution = DonenessTargetsCatalog.resolveDonenessTargets({
    proteinCategory: inferredProtein,
    cutTag: inferredCut,
    method: primaryMethod,
    donenessPreference,
    householdOverrides: extractDonenessOverrides(
      donenessProfile,
      inferredProtein,
      inferredCut
    ),
    enforceSafetyMinimum: options.enforceSafetyMinimum,
  });

  if (donenessResolution.wasRaisedForSafety) {
    addWarning(report, {
      code: "unsafe_target_was_raised",
      message: `Requested target was below safety minimum; raised to ${donenessResolution.targetInternalTempF}°F.`,
      severity: "warn",
      context: donenessResolution,
    });
    addDecision(report, {
      type: "doneness_safety_raise",
      message: "Raised doneness target to meet safety minimum.",
      context: {
        from: donenessPreference,
        to: donenessResolution.targetInternalTempF,
        safetyMin: donenessResolution.safetyMinimumF,
      },
    });
  } else {
    addDecision(report, {
      type: "doneness_resolved",
      message: `Resolved doneness target: ${donenessResolution.targetInternalTempF}°F.`,
      context: donenessResolution,
    });
  }

  // Step adaptation + rewrite hints (from tool substitutions)
  const stepsAdapted = adaptSteps({
    rawSteps,
    method: primaryMethod,
    toolSubstitutions,
    allowStepTextRewrite: options.allowStepTextRewrite,
    report,
  });

  // Build Variant
  const helpers = ensureRecipeVariantHelpers();
  const variant = helpers.create({
    householdId,
    userId,
    title,
    sourceRecipeId: recipe?.id || recipe?.sourceRecipeId || null,
    adapterVersion: ADAPTER_VERSION,
  });

  variant.title = title;
  variant.tags = uniqStrings(tags);
  variant.refs = variant.refs || {};
  variant.refs.sourceRecipeId =
    recipe?.id || recipe?.sourceRecipeId || variant.refs.sourceRecipeId || null;
  variant.refs.adapterVersion = ADAPTER_VERSION;

  variant.summary = variant.summary || {};
  variant.summary.servings = variant.summary.servings || {};
  variant.summary.servings.count = servings;
  variant.summary.servings.unit = "servings";
  variant.summary.methods = variant.summary.methods || {};
  variant.summary.methods.primary = primaryMethod;
  variant.summary.methods.secondary = [];
  variant.summary.time = variant.summary.time || {};
  variant.summary.time.activeSeconds = 0;
  variant.summary.time.restSeconds = 0;
  variant.summary.time.totalSeconds = 0;
  variant.summary.time.confidence = clamp01(recipe?.timeConfidence ?? 0.7, 0.7);
  variant.summary.notes = safeString(
    recipe?.notes || recipe?.summary || "",
    8000,
    ""
  );

  variant.ingredients = ingredients.map((i) => ({ ...i }));

  // Steps in variant (persisted adapted recipe):
  // Keep stable ids; include requires/method hints for compiler
  variant.steps = stepsAdapted.map((s, idx) => ({
    id: s.id || safeId("vstep"),
    order: idx + 1,
    title: s.title,
    text: s.text,
    estimatedSeconds: s.estimatedSeconds ?? 0,
    requires: {
      equipmentIds: uniqStrings(s.requires?.equipmentIds || []),
      methods: uniqStrings(s.requires?.methods || [primaryMethod]),
    },
    notes: safeString(s.notes || "", 2000, ""),
    gate: isPlainObject(s.gate)
      ? {
          required: !!s.gate.required,
          prompt: safeString(s.gate.prompt, 500, ""),
        }
      : { required: false, prompt: "" },
  }));

  // Equipment
  variant.equipment = {
    required: equipmentResolved.filter((e) => !e.optional),
    optional: equipmentResolved.filter((e) => !!e.optional),
    missingAtCompileTime,
  };

  // Doneness
  variant.doneness = {
    proteinCategory: donenessResolution.proteinCategory,
    cutTag: donenessResolution.cutTag,
    preference: donenessPreference || null,
    targetInternalTempF: donenessResolution.targetInternalTempF,
    toleranceF: donenessResolution.toleranceF,
    safetyMinimumF: donenessResolution.safetyMinimumF,
    wasRaisedForSafety: !!donenessResolution.wasRaisedForSafety,
    source: donenessResolution.source,
    ruleId: donenessResolution.ruleId,
  };

  // Substitutions record
  variant.substitutions = variant.substitutions || {
    tools: [],
    ingredients: [],
    methods: [],
  };
  variant.substitutions.tools = toolSubstitutions.map((s) => ({
    missingKey: s.missingKey,
    chosenKey: s.chosenKey,
    fromRuleId: s.fromRuleId,
    confidence: clamp01(s.confidence, 0.5),
    friction: clamp01(s.friction, 0.5),
    notes: safeString(s.notes || "", 1000, ""),
    stepRewriteHints: Array.isArray(s.stepRewriteHints)
      ? deepClone(s.stepRewriteHints)
      : [],
  }));

  // Quality flags
  variant.quality = variant.quality || {
    needsUserReview: true,
    confidence: 0.7,
    flags: [],
    warnings: [],
  };
  variant.quality.needsUserReview = true; // default until user approves in CookSetupModal
  variant.quality.confidence = clamp01(
    donenessResolution.wasRaisedForSafety ? 0.65 : 0.75,
    0.7
  );
  variant.quality.flags = uniqStrings([
    "needs_user_review",
    ...(missingAtCompileTime.length ? ["missing_critical_equipment"] : []),
    ...(donenessResolution.wasRaisedForSafety
      ? ["unsafe_target_was_raised"]
      : []),
    ...(toolSubstitutions.length ? ["method_substitution_made"] : []),
  ]);
  variant.quality.warnings = [];

  // Normalize variant (if schema exists) and return
  const normalizedVariant = helpers.normalize(variant);

  return normalizedVariant;
}

function resolveDonenessPreferenceFromProfile(
  donenessProfile,
  proteinCategory,
  cutTag
) {
  // Tolerant: profile may store per-protein label preference or a default.
  // Accept shapes:
  //  - { defaultLabel: "medium", proteins: { beef: { label: "medium_rare" } } }
  //  - { targets: [{ proteinCategory, cutTag, preference: "medium" }...] }
  //  - { preference: "medium" }
  const p = PROTEIN_CATEGORIES_SAFE(proteinCategory);
  const c = CUT_TAGS_SAFE(cutTag);

  const prof = isPlainObject(donenessProfile) ? donenessProfile : {};

  if (typeof prof.preference === "string" && prof.preference.trim())
    return prof.preference.trim();

  if (typeof prof.defaultLabel === "string" && prof.defaultLabel.trim())
    return prof.defaultLabel.trim();

  if (isPlainObject(prof.proteins)) {
    const entry = prof.proteins[p];
    if (isPlainObject(entry)) {
      if (typeof entry.label === "string" && entry.label.trim())
        return entry.label.trim();
      if (typeof entry.preference === "string" && entry.preference.trim())
        return entry.preference.trim();
    }
  }

  if (Array.isArray(prof.targets)) {
    const hits = prof.targets.filter((t) => isPlainObject(t));
    // most specific match
    const exact = hits.find(
      (t) =>
        safeLower(t.proteinCategory) === safeLower(p) &&
        safeLower(t.cutTag) === safeLower(c) &&
        typeof t.preference === "string"
    );
    if (exact) return exact.preference.trim();

    const proteinOnly = hits.find(
      (t) =>
        safeLower(t.proteinCategory) === safeLower(p) &&
        (!t.cutTag || t.cutTag === "*" || t.cutTag == null) &&
        typeof t.preference === "string"
    );
    if (proteinOnly) return proteinOnly.preference.trim();
  }

  // fallback label per protein
  if (["beef", "lamb", "goat", "venison", "bison"].includes(p)) return "medium";
  if (["pork"].includes(p)) return "safe";
  if (["chicken", "turkey"].includes(p)) return "safe";
  if (["fish", "shellfish"].includes(p)) return "flakes";
  if (["eggs"].includes(p)) return "set";

  return "safe";
}

function extractDonenessOverrides(donenessProfile, proteinCategory, cutTag) {
  // Accept: profile.overrides[proteinCategory][cutTag] etc.
  const p = PROTEIN_CATEGORIES_SAFE(proteinCategory);
  const c = CUT_TAGS_SAFE(cutTag);
  const prof = isPlainObject(donenessProfile) ? donenessProfile : {};

  // direct
  if (isPlainObject(prof.overrides)) {
    const byProtein = prof.overrides[p];
    if (isPlainObject(byProtein)) {
      const byCut = byProtein[c] || byProtein["*"];
      if (isPlainObject(byCut)) {
        return {
          targetInternalTempF:
            byCut.targetInternalTempF ?? byCut.targetF ?? undefined,
          toleranceF: byCut.toleranceF ?? undefined,
        };
      }
    }
  }

  // array form
  if (Array.isArray(prof.targets)) {
    const hit = prof.targets.find(
      (t) =>
        isPlainObject(t) &&
        safeLower(t.proteinCategory) === safeLower(p) &&
        (safeLower(t.cutTag || "*") === safeLower(c) ||
          safeLower(t.cutTag || "*") === "*")
    );
    if (hit) {
      return {
        targetInternalTempF:
          hit.targetInternalTempF ?? hit.targetF ?? undefined,
        toleranceF: hit.toleranceF ?? undefined,
      };
    }
  }

  return null;
}

function PROTEIN_CATEGORIES_SAFE(p) {
  const s = safeLower(p);
  // keep aligned with DonenessTargetsCatalog enums
  const allowed = DonenessTargetsCatalog?.enums?.PROTEIN_CATEGORIES || [];
  if (Array.isArray(allowed) && allowed.includes(s)) return s;
  return s || "unknown";
}

function CUT_TAGS_SAFE(c) {
  const s = safeLower(c);
  const allowed = DonenessTargetsCatalog?.enums?.CUT_TAGS || [];
  if (Array.isArray(allowed) && allowed.includes(s)) return s;
  return s || "whole";
}

function adaptSteps({
  rawSteps,
  method,
  toolSubstitutions,
  allowStepTextRewrite,
  report,
}) {
  const steps = Array.isArray(rawSteps) ? rawSteps : [];
  const out = [];

  // Build rewrite hints list
  const hints = [];
  for (const sub of Array.isArray(toolSubstitutions) ? toolSubstitutions : []) {
    if (Array.isArray(sub.stepRewriteHints)) {
      for (const h of sub.stepRewriteHints) hints.push(h);
    }
  }

  const max = DEFAULTS.maxSteps;
  const trimmed = steps.slice(0, max);

  if (steps.length > max) {
    addWarning(report, {
      code: "steps_truncated",
      message: `Recipe has ${steps.length} steps; truncated to ${max}.`,
      severity: "warn",
      context: { steps: steps.length, max },
    });
  }

  for (let i = 0; i < trimmed.length; i += 1) {
    const text0 = String(trimmed[i] || "").trim();
    if (!text0) continue;

    let text = text0;
    if (allowStepTextRewrite && hints.length) {
      text = applyStepRewriteHints(text0, hints);
    }

    const title = deriveStepTitle(text, i + 1);
    const requires = inferRequiresFromText(text, method);

    out.push({
      id: safeId("vstep"),
      order: out.length + 1,
      title,
      text,
      estimatedSeconds: inferEstimatedSeconds(text),
      requires,
      notes: "",
      gate: inferGate(text),
    });
  }

  // If no steps, create a default one
  if (!out.length) {
    out.push({
      id: safeId("vstep"),
      order: 1,
      title: "Cook",
      text: "Follow the recipe and monitor doneness targets.",
      estimatedSeconds: 0,
      requires: { equipmentIds: [], methods: [method] },
      notes: "",
      gate: { required: false, prompt: "" },
    });
    addWarning(report, {
      code: "steps_missing",
      message: "No steps found in recipe; generated a default step.",
      severity: "warn",
      context: {},
    });
  }

  return out;
}

function deriveStepTitle(text, n) {
  const t = safeLower(text);
  if (t.includes("preheat")) return "Preheat";
  if (t.includes("mix") || t.includes("whisk") || t.includes("stir"))
    return "Mix";
  if (
    t.includes("chop") ||
    t.includes("slice") ||
    t.includes("dice") ||
    t.includes("mince")
  )
    return "Prep";
  if (t.includes("bake")) return "Bake";
  if (t.includes("roast")) return "Roast";
  if (t.includes("grill")) return "Grill";
  if (t.includes("sear")) return "Sear";
  if (t.includes("simmer")) return "Simmer";
  if (t.includes("boil")) return "Boil";
  if (t.includes("rest")) return "Rest";
  if (t.includes("serve")) return "Serve";
  return `Step ${n}`;
}

function inferRequiresFromText(text, method) {
  const t = safeLower(text);
  const equipmentIds = [];
  const methods = [safeLower(method)];

  // Just embed tool keys in "equipmentIds" for compiler mapping if desired
  // (Later you can translate equipmentIds -> equipment item ids.)
  const push = (k) => {
    if (!k) return;
    if (equipmentIds.includes(k)) return;
    equipmentIds.push(k);
  };

  if (
    t.includes("oven") ||
    t.includes("preheat") ||
    t.includes("bake") ||
    t.includes("roast") ||
    t.includes("broil")
  )
    push("appliance:oven");
  if (t.includes("air fry") || t.includes("air-fry"))
    push("appliance:air_fryer");
  if (t.includes("microwave")) push("appliance:microwave");
  if (
    t.includes("stovetop") ||
    t.includes("skillet") ||
    t.includes("pan") ||
    t.includes("burner")
  )
    push("appliance:stovetop");
  if (t.includes("grill")) push("appliance:grill");
  if (
    t.includes("slow cooker") ||
    t.includes("crockpot") ||
    t.includes("crock pot")
  )
    push("appliance:slow_cooker");
  if (t.includes("pressure cooker") || t.includes("instant pot"))
    push("appliance:pressure_cooker");

  if (t.includes("sheet pan")) push("cookware:sheet_pan");
  if (t.includes("dutch oven")) push("cookware:dutch_oven");
  if (t.includes("stock pot") || t.includes("stockpot"))
    push("cookware:stock_pot");
  if (t.includes("skillet")) push("cookware:skillet");

  if (
    t.includes("thermometer") ||
    t.includes("internal temp") ||
    t.includes("°f")
  )
    push("utensil:instant_read_thermometer");

  return { equipmentIds, methods };
}

function inferEstimatedSeconds(text) {
  const t = safeLower(text);
  const mm = t.match(/(\d+)\s*(min|mins|minute|minutes)\b/);
  const hh = t.match(/(\d+)\s*(hr|hrs|hour|hours)\b/);
  const ss = t.match(/(\d+)\s*(sec|secs|second|seconds)\b/);

  let seconds = 0;
  if (mm) seconds += Number(mm[1]) * 60;
  if (hh) seconds += Number(hh[1]) * 3600;
  if (ss) seconds += Number(ss[1]);

  // If "rest" is present, treat as estimated time as well
  if (seconds > 0) return clampInt(seconds, 0, 7 * 24 * 3600, 0);

  return 0;
}

function inferGate(text) {
  const t = safeLower(text);
  if (
    t.includes("until") &&
    (t.includes("golden") ||
      t.includes("tender") ||
      t.includes("done") ||
      t.includes("opaque") ||
      t.includes("flakes"))
  ) {
    return { required: true, prompt: "Confirm doneness before continuing." };
  }
  return { required: false, prompt: "" };
}

/* -------------------------------------------------------------------------- */
/* Public Service                                                              */
/* -------------------------------------------------------------------------- */

const RecipeAdapterService = {
  /**
   * Adapt a raw recipe into a persisted adapted RecipeVariant.
   */
  adaptToVariant(input = {}) {
    const recipe = input.recipe || {};
    const householdId = safeString(input.householdId, 128, "household_default");
    const userId =
      input.userId != null ? safeString(input.userId, 128, "") : null;

    const options = normalizeOptions(input.options);
    const report = createAdapterReport(options);

    try {
      const variant = adaptRecipeToVariantCore({
        recipe,
        householdId,
        userId,
        donenessProfile: input.donenessProfile || null,
        kitchenCaps: input.kitchenCaps || null,
        options,
        report,
      });

      report.finishedAt = nowISO();
      report.ok = true;

      return { ok: true, variant, report };
    } catch (e) {
      console.error("[SSA][RecipeAdapterService] adaptToVariant failed:", e);
      addWarning(report, {
        code: "adapter_exception",
        message: e?.message || "Recipe adaptation failed.",
        severity: "error",
        context: { stack: String(e?.stack || "") },
      });
      report.ok = false;
      report.finishedAt = nowISO();
      return { ok: false, variant: null, report };
    }
  },

  /**
   * Compile a SessionRunner-ready CookPlan from an adapted RecipeVariant.
   */
  compileCookPlan(input = {}) {
    const variant = input.variant || null;
    const options = normalizeOptions(input.options);
    const report = createAdapterReport(options);

    try {
      if (!isPlainObject(variant)) {
        throw new Error("variant_required");
      }

      const cookPlan = compileCookPlanFromVariant(
        variant,
        input.kitchenCaps || null,
        options,
        report
      );

      report.finishedAt = nowISO();
      report.ok = true;

      return { ok: true, cookPlan, report };
    } catch (e) {
      console.error("[SSA][RecipeAdapterService] compileCookPlan failed:", e);
      addWarning(report, {
        code: "compile_exception",
        message: e?.message || "CookPlan compilation failed.",
        severity: "error",
        context: { stack: String(e?.stack || "") },
      });
      report.ok = false;
      report.finishedAt = nowISO();
      return { ok: false, cookPlan: null, report };
    }
  },

  /**
   * Adapt recipe -> variant, then compile -> cookPlan.
   */
  adaptAndCompile(input = {}) {
    const options = normalizeOptions(input.options);
    const report = createAdapterReport(options);

    try {
      const adapted = RecipeAdapterService.adaptToVariant({
        recipe: input.recipe,
        householdId: input.householdId,
        userId: input.userId,
        donenessProfile: input.donenessProfile,
        kitchenCaps: input.kitchenCaps,
        options,
      });

      // merge warnings/notes/decisions into master report
      mergeReports(report, adapted.report);

      if (!adapted.ok || !adapted.variant) {
        report.ok = false;
        report.finishedAt = nowISO();
        return { ok: false, variant: null, cookPlan: null, report };
      }

      const compiled = RecipeAdapterService.compileCookPlan({
        variant: adapted.variant,
        kitchenCaps: input.kitchenCaps,
        options,
      });

      mergeReports(report, compiled.report);

      if (!compiled.ok || !compiled.cookPlan) {
        report.ok = false;
        report.finishedAt = nowISO();
        return { ok: false, variant: adapted.variant, cookPlan: null, report };
      }

      report.ok = true;
      report.finishedAt = nowISO();
      return {
        ok: true,
        variant: adapted.variant,
        cookPlan: compiled.cookPlan,
        report,
      };
    } catch (e) {
      console.error("[SSA][RecipeAdapterService] adaptAndCompile failed:", e);
      addWarning(report, {
        code: "pipeline_exception",
        message: e?.message || "Recipe pipeline failed.",
        severity: "error",
        context: { stack: String(e?.stack || "") },
      });
      report.ok = false;
      report.finishedAt = nowISO();
      return { ok: false, variant: null, cookPlan: null, report };
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeOptions(opts) {
  const o = isPlainObject(opts) ? opts : {};
  return {
    enforceSafetyMinimum:
      typeof o.enforceSafetyMinimum === "boolean"
        ? o.enforceSafetyMinimum
        : DEFAULTS.enforceSafetyMinimum,
    allowMethodFallbacks:
      typeof o.allowMethodFallbacks === "boolean"
        ? o.allowMethodFallbacks
        : DEFAULTS.allowMethodFallbacks,
    allowToolSubstitutions:
      typeof o.allowToolSubstitutions === "boolean"
        ? o.allowToolSubstitutions
        : DEFAULTS.allowToolSubstitutions,
    allowStepTextRewrite:
      typeof o.allowStepTextRewrite === "boolean"
        ? o.allowStepTextRewrite
        : DEFAULTS.allowStepTextRewrite,
    allowTimerInference:
      typeof o.allowTimerInference === "boolean"
        ? o.allowTimerInference
        : DEFAULTS.allowTimerInference,
    allowTargetInference:
      typeof o.allowTargetInference === "boolean"
        ? o.allowTargetInference
        : DEFAULTS.allowTargetInference,
    requireUserReviewOnMissingThermometer:
      typeof o.requireUserReviewOnMissingThermometer === "boolean"
        ? o.requireUserReviewOnMissingThermometer
        : DEFAULTS.requireUserReviewOnMissingThermometer,
    requireUserReviewOnMissingCriticalEquipment:
      typeof o.requireUserReviewOnMissingCriticalEquipment === "boolean"
        ? o.requireUserReviewOnMissingCriticalEquipment
        : DEFAULTS.requireUserReviewOnMissingCriticalEquipment,
    maxSteps: clampInt(
      o.maxSteps ?? DEFAULTS.maxSteps,
      10,
      1000,
      DEFAULTS.maxSteps
    ),
    maxWarnings: clampInt(
      o.maxWarnings ?? DEFAULTS.maxWarnings,
      10,
      1000,
      DEFAULTS.maxWarnings
    ),

    // Optional linking ids
    donenessProfileId: o.donenessProfileId || null,
    kitchenCapabilitiesId: o.kitchenCapabilitiesId || null,
  };
}

/* -------------------------------------------------------------------------- */
/* Report merge                                                                 */
/* -------------------------------------------------------------------------- */

function mergeReports(base, other) {
  if (!base || !other) return;
  if (!Array.isArray(base.notes)) base.notes = [];
  if (!Array.isArray(base.warnings)) base.warnings = [];
  if (!Array.isArray(base.decisions)) base.decisions = [];

  for (const n of Array.isArray(other.notes) ? other.notes : [])
    base.notes.push(n);
  for (const w of Array.isArray(other.warnings) ? other.warnings : [])
    base.warnings.push(w);
  for (const d of Array.isArray(other.decisions) ? other.decisions : [])
    base.decisions.push(d);

  base.ok = base.ok && other.ok;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

export { RecipeAdapterService, ADAPTER_VERSION };
export default RecipeAdapterService;
