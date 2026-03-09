/* eslint-disable no-console */
/**
 * SSA • Recipe Contract (Schema + Helpers)
 * -----------------------------------------------------------------------------
 * File: src/features/recipes/contracts/recipe.schema.js
 *
 * Goals
 * - Single source of truth for what a "Recipe" is in SSA (UI, Dexie, services).
 * - Browser-safe (no Node-only imports).
 * - Strict where it matters (identity, timestamps, core fields) but flexible enough
 *   for scanned/AI/hand-entered recipes (partial data, “unknown” fields).
 * - Includes:
 *    • JSON Schema (draft-2020-12 compatible shape)
 *    • normalization + safe coercion
 *    • validation (zero-dep) + optional Ajv adapter
 *    • stable canonicalization + hashing + diff/patch helpers
 *
 * How to use (examples)
 *   import {
 *     RECIPE_SCHEMA,
 *     createRecipe,
 *     normalizeRecipe,
 *     validateRecipe,
 *     isRecipe,
 *   } from "@/features/recipes/contracts/recipe.schema";
 *
 *   const r = createRecipe({ title: "Lamb Stew", ingredients: [...] });
 *   const { ok, errors, value } = validateRecipe(r, { mode: "strict" });
 *   if (!ok) console.warn(errors);
 *
 * Notes
 * - This file does NOT assume a specific Dexie table name, but the output is
 *   designed to be stored as a single record (e.g., recipes table).
 * - The schema includes "x-ssa" metadata blocks for SSA engines/UI.
 */

/* -------------------------------------------------------------------------- */
/* Utilities (browser-safe, zero-dep)                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_SOURCE = "features/recipes/contracts/recipe.schema";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toStr(v, fallback = "") {
  if (v == null) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function toNum(v, fallback = null) {
  if (v == null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
  }
  return fallback;
}

function arr(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function nowISO() {
  return new Date().toISOString();
}

function safeTrim(s) {
  return typeof s === "string" ? s.trim() : s;
}

/**
 * Very small stable JSON canonicalizer (sort keys recursively).
 * - Drops undefined values
 * - Converts Dates to ISO strings
 */
function canonicalize(value) {
  const seen = new WeakSet();

  function walk(v) {
    if (v === undefined) return undefined;
    if (v === null) return null;

    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return undefined;

    if (v instanceof Date) return v.toISOString();

    if (Array.isArray(v)) {
      const out = [];
      for (const item of v) {
        const w = walk(item);
        if (w !== undefined) out.push(w);
      }
      return out;
    }

    if (isPlainObject(v)) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);

      const keys = Object.keys(v).sort();
      const out = {};
      for (const k of keys) {
        const w = walk(v[k]);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }

    return v;
  }

  return walk(value);
}

/**
 * Fast, deterministic, non-cryptographic hash for cache keys & change detection.
 * (If you need crypto, wrap/replace with WebCrypto SHA-256 elsewhere.)
 */
function hash32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // unsigned
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function makeId(prefix = "rcp") {
  // Prefer crypto.randomUUID when available (modern browsers)
  try {
    // eslint-disable-next-line no-undef
    if (typeof crypto !== "undefined" && crypto?.randomUUID) {
      // rcp_ + uuid without braces
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch (_) {
    // ignore
  }
  // Fallback: time + random
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}_${r}`;
}

function deepFreeze(obj) {
  if (!isPlainObject(obj) && !Array.isArray(obj)) return obj;
  Object.freeze(obj);
  const props = Array.isArray(obj) ? obj : Object.keys(obj);
  for (const k of props) {
    const v = Array.isArray(obj) ? k : obj[k];
    if (isPlainObject(v) || Array.isArray(v)) {
      if (!Object.isFrozen(v)) deepFreeze(v);
    }
  }
  return obj;
}

function pickKnown(obj, allowedKeys) {
  const out = {};
  for (const k of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* JSON Schema (Recipe)                                                       */
/* -------------------------------------------------------------------------- */

export const RECIPE_SCHEMA_VERSION = 1;

/**
 * JSON Schema for SSA Recipe.
 * - Draft: 2020-12 compatible structure.
 * - additionalProperties is allowed at top-level to support future expansion
 *   and scanner/AI capture metadata. We still validate critical fields.
 */
export const RECIPE_SCHEMA = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "ssa://schemas/recipe.schema.json",
  title: "SSA Recipe",
  type: "object",
  required: ["id", "schemaVersion", "title", "createdAt", "updatedAt"],
  additionalProperties: true,

  properties: {
    id: { type: "string", minLength: 8 },

    schemaVersion: { type: "integer", minimum: 1 },

    // Human fields
    title: { type: "string", minLength: 1 },
    subtitle: { type: "string" },
    description: { type: "string" },

    // Classification
    tags: { type: "array", items: { type: "string" }, default: [] },
    cuisine: { type: "string" }, // e.g., "AAI", "West African", "Mediterranean"
    mealType: { type: "string" }, // e.g., breakfast/lunch/dinner/snack
    dishType: { type: "string" }, // stew/soup/bread/etc.
    dietary: { type: "array", items: { type: "string" }, default: [] }, // halal/kosher/gluten-free...

    // Yield & timing
    servings: { type: "number", minimum: 0 },
    yield: {
      type: "object",
      additionalProperties: false,
      properties: {
        amount: { type: "number", minimum: 0 },
        unit: { type: "string" }, // "loaf", "qt", "cookies"
        note: { type: "string" },
      },
    },
    time: {
      type: "object",
      additionalProperties: false,
      properties: {
        prepMin: { type: "number", minimum: 0 },
        cookMin: { type: "number", minimum: 0 },
        restMin: { type: "number", minimum: 0 },
        totalMin: { type: "number", minimum: 0 },
      },
    },

    // Ingredients
    ingredients: {
      type: "array",
      default: [],
      items: {
        type: "object",
        required: ["id", "name"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 6 }, // per-ingredient id
          name: { type: "string", minLength: 1 }, // "lamb shoulder"
          amount: { type: "number", minimum: 0 }, // quantity numeric if known
          unit: { type: "string" }, // "lb", "tsp", "cup"
          // For SSA inventory linking
          itemRef: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string" }, // "inventory"|"catalog"|"raw"
              id: { type: "string" },
              sku: { type: "string" },
              canonicalName: { type: "string" },
            },
          },
          preparation: { type: "string" }, // "diced", "minced"
          optional: { type: "boolean", default: false },
          group: { type: "string" }, // "Sauce", "Dough"
          notes: { type: "string" },
          // Original text fragment from scan/recipe
          raw: { type: "string" },
        },
      },
    },

    // Steps / instructions
    steps: {
      type: "array",
      default: [],
      items: {
        type: "object",
        required: ["id", "text"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 6 },
          text: { type: "string", minLength: 1 },
          // Optional structured helper fields for SessionRunner / timers
          durationMin: { type: "number", minimum: 0 },
          temperature: {
            type: "object",
            additionalProperties: false,
            properties: {
              value: { type: "number" },
              unit: { type: "string" }, // "F"|"C"
            },
          },
          equipment: { type: "array", items: { type: "string" }, default: [] },
          // SSA task integration
          tasks: {
            type: "array",
            default: [],
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                kind: { type: "string" }, // "prep"|"cook"|"clean"|"rest"
                label: { type: "string" },
                minutes: { type: "number", minimum: 0 },
                // may link to global task ids later
                taskRef: { type: "string" },
              },
            },
          },
          // for timer panel integration
          timers: {
            type: "array",
            default: [],
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "seconds"],
              properties: {
                label: { type: "string" },
                seconds: { type: "number", minimum: 0 },
              },
            },
          },
          notes: { type: "string" },
          raw: { type: "string" },
        },
      },
    },

    // Nutrition (optional; can be populated later)
    nutrition: {
      type: "object",
      additionalProperties: true,
      properties: {
        perServing: { type: "object", additionalProperties: true },
        totals: { type: "object", additionalProperties: true },
        source: { type: "string" }, // "usda"|"manual"|"import"
      },
    },

    // Media / sources
    sources: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          kind: { type: "string" }, // "url"|"book"|"person"|"scan"
          title: { type: "string" },
          author: { type: "string" },
          url: { type: "string" },
          note: { type: "string" },
          capturedAt: { type: "string" }, // ISO
        },
      },
    },
    media: {
      type: "object",
      additionalProperties: true,
      properties: {
        imageUrl: { type: "string" },
        gallery: { type: "array", items: { type: "string" }, default: [] },
      },
    },

    // SSA lifecycle
    status: { type: "string", default: "active" }, // active|draft|archived
    archived: { type: "boolean", default: false },

    // Provenance & metadata
    createdAt: { type: "string" }, // ISO
    updatedAt: { type: "string" }, // ISO
    createdBy: { type: "string" }, // userId/deviceId
    updatedBy: { type: "string" },
    source: { type: "string", default: DEFAULT_SOURCE },

    // Scanner / AI capture payloads (optional)
    capture: {
      type: "object",
      additionalProperties: true,
      properties: {
        rawText: { type: "string" }, // OCR/scan raw
        parsed: { type: "object", additionalProperties: true }, // parser output
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },

    // Change detection
    contentHash: { type: "string" }, // stable hash of canonical recipe content
  },

  "x-ssa": {
    contract: "Recipe",
    version: RECIPE_SCHEMA_VERSION,
    idPrefix: "rcp",
    ingredientIdPrefix: "ing",
    stepIdPrefix: "stp",
  },
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function normalizeIngredient(input, { ingredientIdPrefix = "ing" } = {}) {
  const o = isPlainObject(input) ? { ...input } : { name: toStr(input, "") };
  const id = toStr(o.id, "").trim() || makeId(ingredientIdPrefix);

  const name = safeTrim(toStr(o.name, "")) || safeTrim(toStr(o.raw, "")) || "";
  const amount = toNum(o.amount, null);
  const unit = safeTrim(toStr(o.unit, "")) || undefined;

  const preparation = safeTrim(toStr(o.preparation, "")) || undefined;
  const optional = toBool(o.optional, false);
  const group = safeTrim(toStr(o.group, "")) || undefined;
  const notes = safeTrim(toStr(o.notes, "")) || undefined;
  const raw = safeTrim(toStr(o.raw, "")) || undefined;

  let itemRef = undefined;
  if (isPlainObject(o.itemRef)) {
    itemRef = {
      kind: safeTrim(toStr(o.itemRef.kind, "")) || undefined,
      id: safeTrim(toStr(o.itemRef.id, "")) || undefined,
      sku: safeTrim(toStr(o.itemRef.sku, "")) || undefined,
      canonicalName: safeTrim(toStr(o.itemRef.canonicalName, "")) || undefined,
    };
    // drop if empty
    if (!itemRef.kind && !itemRef.id && !itemRef.sku && !itemRef.canonicalName)
      itemRef = undefined;
  }

  // Keep unknown props (scanner metadata, etc.)
  return {
    ...o,
    id,
    name,
    ...(amount == null ? {} : { amount }),
    ...(unit ? { unit } : {}),
    ...(preparation ? { preparation } : {}),
    ...(optional ? { optional } : {}),
    ...(group ? { group } : {}),
    ...(notes ? { notes } : {}),
    ...(raw ? { raw } : {}),
    ...(itemRef ? { itemRef } : {}),
  };
}

function normalizeStep(input, { stepIdPrefix = "stp" } = {}) {
  const o = isPlainObject(input) ? { ...input } : { text: toStr(input, "") };
  const id = toStr(o.id, "").trim() || makeId(stepIdPrefix);

  const text = safeTrim(toStr(o.text, "")) || safeTrim(toStr(o.raw, "")) || "";
  const durationMin = toNum(o.durationMin, null);
  const notes = safeTrim(toStr(o.notes, "")) || undefined;
  const raw = safeTrim(toStr(o.raw, "")) || undefined;

  let temperature = undefined;
  if (isPlainObject(o.temperature)) {
    const tv = toNum(o.temperature.value, null);
    const tu = safeTrim(toStr(o.temperature.unit, "")) || undefined;
    if (tv != null || tu) {
      temperature = {
        ...(tv == null ? {} : { value: tv }),
        ...(tu ? { unit: tu } : {}),
      };
    }
  }

  const equipment = arr(o.equipment)
    .map((x) => safeTrim(toStr(x, "")))
    .filter(Boolean);

  const tasks = arr(o.tasks)
    .map((t) => (isPlainObject(t) ? t : { label: toStr(t, "") }))
    .map((t) => ({
      ...t,
      kind: safeTrim(toStr(t.kind, "")) || undefined,
      label: safeTrim(toStr(t.label, "")) || undefined,
      minutes: toNum(t.minutes, null) ?? undefined,
      taskRef: safeTrim(toStr(t.taskRef, "")) || undefined,
    }))
    .filter((t) => t.label || t.kind || t.minutes != null || t.taskRef);

  const timers = arr(o.timers)
    .map((tm) => (isPlainObject(tm) ? tm : null))
    .filter(Boolean)
    .map((tm) => ({
      label: safeTrim(toStr(tm.label, "")) || "Timer",
      seconds: Math.max(0, toNum(tm.seconds, 0) || 0),
    }))
    .filter((tm) => tm.label && Number.isFinite(tm.seconds));

  return {
    ...o,
    id,
    text,
    ...(durationMin == null ? {} : { durationMin }),
    ...(temperature ? { temperature } : {}),
    ...(equipment.length ? { equipment } : {}),
    ...(tasks.length ? { tasks } : {}),
    ...(timers.length ? { timers } : {}),
    ...(notes ? { notes } : {}),
    ...(raw ? { raw } : {}),
  };
}

/**
 * Normalize a recipe into SSA’s canonical record shape.
 * - Keeps unknown properties (future fields, capture metadata).
 * - Ensures ids/timestamps exist, arrays exist, strings trimmed.
 * - Recomputes contentHash if requested.
 */
export function normalizeRecipe(input, opts = {}) {
  const {
    source = DEFAULT_SOURCE,
    keepUnknown = true,
    recomputeHash = true,
    idPrefix = RECIPE_SCHEMA["x-ssa"]?.idPrefix || "rcp",
    ingredientIdPrefix = RECIPE_SCHEMA["x-ssa"]?.ingredientIdPrefix || "ing",
    stepIdPrefix = RECIPE_SCHEMA["x-ssa"]?.stepIdPrefix || "stp",
    updatedAt = nowISO(),
  } = opts;

  const base = isPlainObject(input) ? { ...input } : {};
  const id = safeTrim(toStr(base.id, "")) || makeId(idPrefix);

  const createdAt = safeTrim(toStr(base.createdAt, "")) || updatedAt;

  const title = safeTrim(toStr(base.title, "")) || "Untitled Recipe";
  const subtitle = safeTrim(toStr(base.subtitle, "")) || undefined;
  const description = safeTrim(toStr(base.description, "")) || undefined;

  const tags = arr(base.tags)
    .map((t) => safeTrim(toStr(t, "")))
    .filter(Boolean);
  const dietary = arr(base.dietary)
    .map((t) => safeTrim(toStr(t, "")))
    .filter(Boolean);

  const cuisine = safeTrim(toStr(base.cuisine, "")) || undefined;
  const mealType = safeTrim(toStr(base.mealType, "")) || undefined;
  const dishType = safeTrim(toStr(base.dishType, "")) || undefined;

  const servings = toNum(base.servings, null);

  let yieldObj = undefined;
  if (isPlainObject(base.yield)) {
    const amount = toNum(base.yield.amount, null);
    const unit = safeTrim(toStr(base.yield.unit, "")) || undefined;
    const note = safeTrim(toStr(base.yield.note, "")) || undefined;
    if (amount != null || unit || note) {
      yieldObj = {
        ...(amount == null ? {} : { amount }),
        ...(unit ? { unit } : {}),
        ...(note ? { note } : {}),
      };
    }
  }

  let time = undefined;
  if (isPlainObject(base.time)) {
    const prepMin = toNum(base.time.prepMin, null);
    const cookMin = toNum(base.time.cookMin, null);
    const restMin = toNum(base.time.restMin, null);
    const totalMin = toNum(base.time.totalMin, null);
    if (
      prepMin != null ||
      cookMin != null ||
      restMin != null ||
      totalMin != null
    ) {
      time = {
        ...(prepMin == null ? {} : { prepMin }),
        ...(cookMin == null ? {} : { cookMin }),
        ...(restMin == null ? {} : { restMin }),
        ...(totalMin == null ? {} : { totalMin }),
      };
    }
  }

  const ingredients = arr(base.ingredients).map((x) =>
    normalizeIngredient(x, { ingredientIdPrefix })
  );
  const steps = arr(base.steps).map((x) => normalizeStep(x, { stepIdPrefix }));

  const status = safeTrim(toStr(base.status, "")) || "active";
  const archived = toBool(base.archived, status === "archived");

  const createdBy = safeTrim(toStr(base.createdBy, "")) || undefined;
  const updatedBy = safeTrim(toStr(base.updatedBy, "")) || undefined;

  const sources = arr(base.sources)
    .map((s) =>
      isPlainObject(s) ? s : { kind: "unknown", title: toStr(s, "") }
    )
    .map((s) => ({
      ...s,
      kind: safeTrim(toStr(s.kind, "")) || undefined,
      title: safeTrim(toStr(s.title, "")) || undefined,
      author: safeTrim(toStr(s.author, "")) || undefined,
      url: safeTrim(toStr(s.url, "")) || undefined,
      note: safeTrim(toStr(s.note, "")) || undefined,
      capturedAt: safeTrim(toStr(s.capturedAt, "")) || undefined,
    }))
    .filter(
      (s) => s.kind || s.title || s.author || s.url || s.note || s.capturedAt
    );

  const media = isPlainObject(base.media) ? { ...base.media } : undefined;

  const nutrition = isPlainObject(base.nutrition)
    ? { ...base.nutrition }
    : undefined;
  const capture = isPlainObject(base.capture) ? { ...base.capture } : undefined;

  const known = {
    id,
    schemaVersion: RECIPE_SCHEMA_VERSION,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(description ? { description } : {}),
    ...(tags.length ? { tags } : {}),
    ...(cuisine ? { cuisine } : {}),
    ...(mealType ? { mealType } : {}),
    ...(dishType ? { dishType } : {}),
    ...(dietary.length ? { dietary } : {}),
    ...(servings == null ? {} : { servings }),
    ...(yieldObj ? { yield: yieldObj } : {}),
    ...(time ? { time } : {}),
    ingredients,
    steps,
    ...(nutrition ? { nutrition } : {}),
    ...(sources.length ? { sources } : {}),
    ...(media ? { media } : {}),
    status: archived ? "archived" : status,
    archived,
    createdAt,
    updatedAt,
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
    source: safeTrim(toStr(base.source, "")) || source,
    ...(capture ? { capture } : {}),
  };

  const out = keepUnknown ? { ...base, ...known } : known;

  if (recomputeHash) {
    out.contentHash = computeRecipeContentHash(out);
  } else if (base.contentHash) {
    out.contentHash = toStr(base.contentHash, "");
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Content hash (stable)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Only hash “meaningful content” (not updatedAt, contentHash itself, etc.)
 * so you can detect real recipe edits without false positives.
 */
export function computeRecipeContentHash(recipe) {
  const r = isPlainObject(recipe) ? recipe : {};

  const meaningful = {
    schemaVersion: r.schemaVersion ?? RECIPE_SCHEMA_VERSION,
    title: r.title,
    subtitle: r.subtitle,
    description: r.description,
    tags: r.tags,
    cuisine: r.cuisine,
    mealType: r.mealType,
    dishType: r.dishType,
    dietary: r.dietary,
    servings: r.servings,
    yield: r.yield,
    time: r.time,
    ingredients: r.ingredients,
    steps: r.steps,
    nutrition: r.nutrition,
    sources: r.sources,
    media: r.media,
    archived: r.archived,
    status: r.status,
  };

  const s = stableStringify(meaningful);
  return hash32(s);
}

/* -------------------------------------------------------------------------- */
/* Creation helpers                                                           */
/* -------------------------------------------------------------------------- */

export function createRecipe(input = {}, opts = {}) {
  const base = isPlainObject(input) ? input : {};
  const updatedAt = opts.updatedAt || nowISO();
  const createdAt = base.createdAt || updatedAt;

  return normalizeRecipe(
    {
      ...base,
      createdAt,
      updatedAt,
    },
    {
      ...opts,
      recomputeHash: true,
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Validation (zero-dep) + optional Ajv adapter                                */
/* -------------------------------------------------------------------------- */

/**
 * Validation modes
 * - "loose": minimal checks (id/title/timestamps)
 * - "strict": checks core structure (ingredients/steps ids/text/name)
 */
function validateLoose(recipe) {
  const errors = [];

  if (!isPlainObject(recipe)) {
    errors.push({
      path: "",
      code: "TYPE",
      message: "Recipe must be an object.",
    });
    return errors;
  }

  const id = toStr(recipe.id, "").trim();
  if (!id || id.length < 8)
    errors.push({ path: "id", code: "REQUIRED", message: "id is required." });

  const title = toStr(recipe.title, "").trim();
  if (!title)
    errors.push({
      path: "title",
      code: "REQUIRED",
      message: "title is required.",
    });

  const createdAt = toStr(recipe.createdAt, "").trim();
  if (!createdAt)
    errors.push({
      path: "createdAt",
      code: "REQUIRED",
      message: "createdAt is required.",
    });

  const updatedAt = toStr(recipe.updatedAt, "").trim();
  if (!updatedAt)
    errors.push({
      path: "updatedAt",
      code: "REQUIRED",
      message: "updatedAt is required.",
    });

  const sv = recipe.schemaVersion;
  if (!Number.isInteger(sv) || sv < 1) {
    errors.push({
      path: "schemaVersion",
      code: "INVALID",
      message: "schemaVersion must be an integer >= 1.",
    });
  }

  return errors;
}

function validateStrict(recipe) {
  const errors = validateLoose(recipe);
  if (errors.length) return errors;

  // Ingredients
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients
    : [];
  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    if (!isPlainObject(ing)) {
      errors.push({
        path: `ingredients[${i}]`,
        code: "TYPE",
        message: "Ingredient must be an object.",
      });
      continue;
    }
    const iid = toStr(ing.id, "").trim();
    if (!iid)
      errors.push({
        path: `ingredients[${i}].id`,
        code: "REQUIRED",
        message: "Ingredient id is required.",
      });

    const name = toStr(ing.name, "").trim();
    if (!name)
      errors.push({
        path: `ingredients[${i}].name`,
        code: "REQUIRED",
        message: "Ingredient name is required.",
      });

    const amount = ing.amount;
    if (
      amount != null &&
      !(typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
    ) {
      errors.push({
        path: `ingredients[${i}].amount`,
        code: "INVALID",
        message: "Ingredient amount must be a number >= 0 when present.",
      });
    }
  }

  // Steps
  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (!isPlainObject(st)) {
      errors.push({
        path: `steps[${i}]`,
        code: "TYPE",
        message: "Step must be an object.",
      });
      continue;
    }
    const sid = toStr(st.id, "").trim();
    if (!sid)
      errors.push({
        path: `steps[${i}].id`,
        code: "REQUIRED",
        message: "Step id is required.",
      });

    const text = toStr(st.text, "").trim();
    if (!text)
      errors.push({
        path: `steps[${i}].text`,
        code: "REQUIRED",
        message: "Step text is required.",
      });

    const durationMin = st.durationMin;
    if (
      durationMin != null &&
      !(
        typeof durationMin === "number" &&
        Number.isFinite(durationMin) &&
        durationMin >= 0
      )
    ) {
      errors.push({
        path: `steps[${i}].durationMin`,
        code: "INVALID",
        message: "durationMin must be a number >= 0 when present.",
      });
    }

    const timers = Array.isArray(st.timers) ? st.timers : [];
    for (let j = 0; j < timers.length; j++) {
      const tm = timers[j];
      if (!isPlainObject(tm)) {
        errors.push({
          path: `steps[${i}].timers[${j}]`,
          code: "TYPE",
          message: "Timer must be an object.",
        });
        continue;
      }
      const label = toStr(tm.label, "").trim();
      const seconds = tm.seconds;
      if (!label)
        errors.push({
          path: `steps[${i}].timers[${j}].label`,
          code: "REQUIRED",
          message: "Timer label is required.",
        });
      if (
        !(
          typeof seconds === "number" &&
          Number.isFinite(seconds) &&
          seconds >= 0
        )
      ) {
        errors.push({
          path: `steps[${i}].timers[${j}].seconds`,
          code: "INVALID",
          message: "Timer seconds must be a number >= 0.",
        });
      }
    }
  }

  return errors;
}

/**
 * validateRecipe
 * - Returns { ok, errors, value }
 * - Optionally normalizes first (recommended).
 *
 * Options:
 * - mode: "loose" | "strict"  (default: "strict")
 * - normalize: boolean        (default: true)
 * - ajvValidate: function     (optional) if you already have Ajv compiled validator
 *
 * If you want Ajv:
 *   // somewhere else:
 *   // const ajv = new Ajv({ allErrors:true, strict:false });
 *   // const validate = ajv.compile(RECIPE_SCHEMA);
 *   // validateRecipe(recipe, { ajvValidate: validate })
 */
export function validateRecipe(input, opts = {}) {
  const {
    mode = "strict",
    normalize: doNormalize = true,
    ajvValidate = null,
    normalizationOptions = {},
  } = opts;

  const value = doNormalize
    ? normalizeRecipe(input, normalizationOptions)
    : input;

  // If caller provides Ajv validator, use it as the primary validator,
  // but still run minimal checks to produce SSA-friendly error objects.
  if (typeof ajvValidate === "function") {
    const ok = !!ajvValidate(value);
    if (ok) return { ok: true, errors: [], value };

    const ajvErrors = arr(ajvValidate.errors).map((e) => ({
      path: e?.instancePath
        ? e.instancePath.replace(/^\//, "").replaceAll("/", ".")
        : "",
      code: "SCHEMA",
      message: e?.message || "Schema validation error",
      meta: e,
    }));

    // Add minimal contract checks in case Ajv was configured loosely
    const basic =
      mode === "loose" ? validateLoose(value) : validateStrict(value);
    const errors = [...ajvErrors, ...basic];

    return { ok: false, errors, value };
  }

  const errors =
    mode === "loose" ? validateLoose(value) : validateStrict(value);
  return { ok: errors.length === 0, errors, value };
}

/* -------------------------------------------------------------------------- */
/* Type guards                                                                */
/* -------------------------------------------------------------------------- */

export function isRecipe(v) {
  if (!isPlainObject(v)) return false;
  if (!v.id || typeof v.id !== "string") return false;
  if (!v.title || typeof v.title !== "string") return false;
  if (!v.createdAt || typeof v.createdAt !== "string") return false;
  if (!v.updatedAt || typeof v.updatedAt !== "string") return false;
  if (!Number.isInteger(v.schemaVersion) || v.schemaVersion < 1) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Diff + Patch (for optimistic UI, conflict resolution, syncing)             */
/* -------------------------------------------------------------------------- */

/**
 * Shallow-ish diff for recipe updates:
 * - Produces { set: {k:v}, unset: [k], changedPaths: [...] }
 * - Intended for syncing or optimistic updates, not a full JSON Patch impl.
 */
export function diffRecipe(a, b, opts = {}) {
  const { ignore = ["updatedAt", "contentHash"], maxDepth = 6 } = opts;

  const out = { set: {}, unset: [], changedPaths: [] };
  const A = isPlainObject(a) ? a : {};
  const B = isPlainObject(b) ? b : {};

  function walk(path, va, vb, depth) {
    if (ignore.includes(path.split(".")[0])) return;
    if (depth > maxDepth) {
      if (stableStringify(va) !== stableStringify(vb)) {
        out.set[path] = vb;
        out.changedPaths.push(path);
      }
      return;
    }

    const ta = Array.isArray(va)
      ? "array"
      : isPlainObject(va)
      ? "object"
      : typeof va;
    const tb = Array.isArray(vb)
      ? "array"
      : isPlainObject(vb)
      ? "object"
      : typeof vb;

    if (ta !== tb) {
      out.set[path] = vb;
      out.changedPaths.push(path);
      return;
    }

    if (ta === "object") {
      const keys = new Set([
        ...Object.keys(va || {}),
        ...Object.keys(vb || {}),
      ]);
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in (vb || {}))) {
          out.unset.push(p);
          out.changedPaths.push(p);
        } else if (!(k in (va || {}))) {
          out.set[p] = vb[k];
          out.changedPaths.push(p);
        } else {
          walk(p, va[k], vb[k], depth + 1);
        }
      }
      return;
    }

    if (ta === "array") {
      // Arrays: compare canonical string (simple + deterministic)
      if (stableStringify(va) !== stableStringify(vb)) {
        out.set[path] = vb;
        out.changedPaths.push(path);
      }
      return;
    }

    // primitives
    if (va !== vb) {
      out.set[path] = vb;
      out.changedPaths.push(path);
    }
  }

  walk("", A, B, 0);

  // Root path "" is not usable for setters; collapse into whole object set
  if (out.set[""] !== undefined) {
    const v = out.set[""];
    delete out.set[""];
    out.set = { ...out.set, ...v };
  }

  return out;
}

/**
 * Applies a diff-like patch from diffRecipe to a recipe object.
 * - set: dot-path assignments
 * - unset: dot-path deletions
 */
export function patchRecipe(recipe, patch, opts = {}) {
  const { recomputeHash = true, updatedAt = nowISO() } = opts;
  const base = isPlainObject(recipe) ? { ...recipe } : {};

  const set = isPlainObject(patch?.set) ? patch.set : {};
  const unset = Array.isArray(patch?.unset) ? patch.unset : [];

  function setPath(obj, path, value) {
    const parts = path.split(".").filter(Boolean);
    if (!parts.length) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!isPlainObject(cur[k])) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function delPath(obj, path) {
    const parts = path.split(".").filter(Boolean);
    if (!parts.length) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!isPlainObject(cur[k])) return;
      cur = cur[k];
    }
    delete cur[parts[parts.length - 1]];
  }

  for (const [k, v] of Object.entries(set)) {
    setPath(base, k, v);
  }
  for (const p of unset) delPath(base, p);

  base.updatedAt = updatedAt;

  const normalized = normalizeRecipe(base, { recomputeHash, updatedAt });
  return normalized;
}

/* -------------------------------------------------------------------------- */
/* Contract helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Returns a minimal “identity summary” for logs, events, UI headers.
 */
export function getRecipeSummary(recipe) {
  const r = isPlainObject(recipe) ? recipe : {};
  return {
    id: toStr(r.id, ""),
    title: toStr(r.title, "Untitled Recipe"),
    cuisine: toStr(r.cuisine, ""),
    tags: Array.isArray(r.tags) ? r.tags : [],
    archived: !!r.archived,
    updatedAt: toStr(r.updatedAt, ""),
    contentHash: toStr(r.contentHash, ""),
  };
}

/**
 * Produces a “content-only” object suitable for deterministic comparisons
 * (omits timestamps, ids remain).
 */
export function getRecipeContentView(recipe) {
  const r = normalizeRecipe(recipe, { recomputeHash: false });
  const omit = new Set([
    "createdAt",
    "updatedAt",
    "contentHash",
    "source",
    "createdBy",
    "updatedBy",
  ]);
  const out = {};
  for (const k of Object.keys(r)) {
    if (!omit.has(k)) out[k] = r[k];
  }
  return out;
}

/**
 * Useful for indexing/search: tokens from title/tags/ingredients.
 */
export function recipeSearchTokens(recipe) {
  const r = normalizeRecipe(recipe, { recomputeHash: false });

  const tokens = new Set();

  function add(s) {
    const t = toStr(s, "").toLowerCase().trim();
    if (!t) return;
    // split on non-alphanum
    for (const part of t.split(/[^a-z0-9]+/g)) {
      if (part && part.length >= 2) tokens.add(part);
    }
  }

  add(r.title);
  add(r.subtitle);
  add(r.description);
  add(r.cuisine);
  add(r.mealType);
  add(r.dishType);

  for (const t of arr(r.tags)) add(t);
  for (const d of arr(r.dietary)) add(d);

  for (const ing of arr(r.ingredients)) {
    add(ing?.name);
    add(ing?.preparation);
    add(ing?.group);
  }

  return Array.from(tokens);
}

/* -------------------------------------------------------------------------- */
/* Exports (named)                                                            */
/* -------------------------------------------------------------------------- */

export const RecipeContract = deepFreeze({
  version: RECIPE_SCHEMA_VERSION,
  schema: RECIPE_SCHEMA,
  create: createRecipe,
  normalize: normalizeRecipe,
  validate: validateRecipe,
  is: isRecipe,
  hash: computeRecipeContentHash,
  diff: diffRecipe,
  patch: patchRecipe,
  summary: getRecipeSummary,
  tokens: recipeSearchTokens,
});
