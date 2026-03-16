/**
 * @file C:\Users\larho\suka-smart-assistant\src\engines\synthesis\PreferenceAdapter.js
 *
 * PreferenceAdapter — single, defensive read API for user/household preferences
 * across all domains (recipe/cooking, cleaning, garden, animal, preservation).
 *
 * PIPELINE FIT
 * imports → normalize → intelligence → synthesis → **PreferenceAdapter (this)**
 * → lead-time/validator/dedup → automation runtime → (optional) hub export elsewhere
 *
 * WHAT THIS MODULE DOES
 * - Loads and merges preferences from multiple sources (runtime overrides → user profile
 *   → household profile → domain defaults).
 * - Normalizes & validates into a canonical schema used by engines.
 * - Exposes helpers to resolve domain-specific preference views for a given import item.
 * - Emits automation telemetry (no household mutation, so no hub export here).
 *
 * EVENT ENVELOPE SHAPE (every emit): { type, ts, source, data }
 *   - prefs.loaded
 *   - prefs.resolved
 *   - prefs.error
 *
 * EXTENSION POINTS
 * - registerSchema(domain, schemaObject)
 * - registerNormalizer(key, fn(value) -> normalizedValue)
 *
 * Notes:
 * - This module is *read-only*; it does not persist or mutate household data.
 * - For ephemeral runtime overrides (e.g., “tonight go mild spice”), use setRuntimeOverride().
 */

import { emit as emitEventBus } from "@/services/events/eventBus";

const SOURCE = "PreferenceAdapter";

// ───────────────────────────────────────────────────────────────────────────────
// In-memory state (runtime overrides do not persist)

const RUNTIME_OVERRIDES = {}; // deep path -> value
const SCHEMAS = new Map(); // domain -> schema object
const NORMALIZERS = new Map(); // key -> fn(value)=>normalized

// Built-in canonical keys & defaults (forward-looking; safe, minimal)
const DEFAULTS = {
  core: {
    locale: "en-US",
    units: "metric", // 'us-customary'
    dietary: {
      vegetarian: false,
      vegan: false,
      halal: false, // informational; engines should not infer sensitive attrs on their own
      kosher: false, // informational
      allergies: [], // ['peanut','tree-nut','gluten','shellfish','dairy','egg','soy','sesame']
      dislikes: [], // ['cilantro', 'anchovy']
      sodiumLimitMgPerDay: null,
      sugarLimitGPerDay: null,
    },
  },
  recipe: {
    doneness: {
      // per protein type; engines can map ingredients → proteinKey
      beef: "medium", // 'rare'|'medium-rare'|'medium'|'medium-well'|'well'
      chicken: "well", // safety-first default
      pork: "medium",
      lamb: "medium",
      fish: "just-done",
      egg: "set",
    },
    spiceTolerance: "medium", // 'low'|'medium'|'high'
    oilPreference: "neutral", // 'neutral'|'olive'|'butter'|'ghee'
    preferredCuisines: [], // ranking/whitelist
    avoidMethods: [], // ['deep-fry', 'sous-vide']
  },
  cleaning: {
    scentFamily: "unscented", // 'unscented'|'citrus'|'floral'|'wood'|'fresh'
    bleachAllowed: false,
    ammoniaAllowed: false,
    petSafeOnly: true,
    sanitizerContactMin: 10,
    surfaces: {
      // per-surface preferences
      hardwood: { waterMinimize: true },
      stone: { acidAvoid: true },
    },
  },
  garden: {
    organicOnly: true,
    pollinatorSafe: true,
    wateringWindow: ["06:00", "09:00"], // for engines to schedule watering
    composting: { enabled: true },
  },
  animal: {
    feedBrandsPreferred: [],
    treatsLimitPerDay: 2,
    rawFoodAllowed: false,
  },
  preservation: {
    jarSizeDefaultMl: 500,
    pectinPreferred: "low-sugar", // 'regular'|'low-sugar'|'none'
  },
};

// Register minimal schemas (keys marked as optional to allow extension)
registerSchema("core", {
  type: "object",
  properties: {
    locale: { type: "string" },
    units: { enum: ["metric", "us-customary"] },
    dietary: {
      type: "object",
      properties: {
        vegetarian: { type: "boolean" },
        vegan: { type: "boolean" },
        halal: { type: "boolean" },
        kosher: { type: "boolean" },
        allergies: { type: "array" },
        dislikes: { type: "array" },
        sodiumLimitMgPerDay: { type: ["number", "null"] },
        sugarLimitGPerDay: { type: ["number", "null"] },
      },
    },
  },
});

registerSchema("recipe", {
  type: "object",
  properties: {
    doneness: { type: "object" },
    spiceTolerance: { enum: ["low", "medium", "high"] },
    oilPreference: { enum: ["neutral", "olive", "butter", "ghee"] },
    preferredCuisines: { type: "array" },
    avoidMethods: { type: "array" },
  },
});

registerSchema("cleaning", {
  type: "object",
  properties: {
    scentFamily: { enum: ["unscented", "citrus", "floral", "wood", "fresh"] },
    bleachAllowed: { type: "boolean" },
    ammoniaAllowed: { type: "boolean" },
    petSafeOnly: { type: "boolean" },
    sanitizerContactMin: { type: "number" },
    surfaces: { type: "object" },
  },
});

registerSchema("garden", {
  type: "object",
  properties: {
    organicOnly: { type: "boolean" },
    pollinatorSafe: { type: "boolean" },
    wateringWindow: { type: "array" }, // [startHH:mm, endHH:mm]
    composting: { type: "object" },
  },
});

registerSchema("animal", {
  type: "object",
  properties: {
    feedBrandsPreferred: { type: "array" },
    treatsLimitPerDay: { type: "number" },
    rawFoodAllowed: { type: "boolean" },
  },
});

registerSchema("preservation", {
  type: "object",
  properties: {
    jarSizeDefaultMl: { type: "number" },
    pectinPreferred: { enum: ["regular", "low-sugar", "none"] },
  },
});

// Example normalizers (callers may add more at runtime)
registerNormalizer("core.units", (v) =>
  v === "imperial" ? "us-customary" : v
);
registerNormalizer("recipe.spiceTolerance", (v) =>
  oneOf(v, ["low", "medium", "high"], "medium")
);
registerNormalizer("cleaning.scentFamily", (v) =>
  mapAlias(v, {
    none: "unscented",
    no: "unscented",
    fragranceFree: "unscented",
  })
);

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Load and merge preferences from multiple sources (highest precedence last):
 *  1) defaults (internal)
 *  2) household profile (soft import: src/config/householdPrefs.js)
 *  3) user profile (soft import: src/config/userPrefs.js)
 *  4) preferences store/service (soft import: src/services/preferences/PreferencesStore.js -> getAll())
 *  5) runtime overrides (in-memory)
 *
 * @returns {Promise<{ ok:boolean, prefs: Preferences, sources: string[] }>}
 */
export async function load() {
  const sources = [];
  try {
    const household = await softImport("src/config/householdPrefs.js");
    const user = await softImport("src/config/userPrefs.js");
    const store =
      (await softImport("src/services/preferences/PreferencesStore.js")) ||
      (await softImport("src/domain/preferences/PreferencesStore.js"));

    const storePrefs =
      (store?.getAll && (await tryCall(() => store.getAll()))) ||
      (store?.default?.getAll &&
        (await tryCall(() => store.default.getAll()))) ||
      null;

    const merged = deepMerge(
      {},
      DEFAULTS,
      household ? household.default || household : null,
      user ? user.default || user : null,
      storePrefs || null,
      overridesAsTree(RUNTIME_OVERRIDES)
    );

    // Normalize & validate
    const normalized = normalizeAll(merged);
    const { ok, errors } = validateAll(normalized);

    emit("prefs.loaded", {
      ok,
      errorCount: errors.length,
      sources: buildSourcesList(household, user, storePrefs),
    });

    if (!ok) {
      emit("prefs.error", { reason: "VALIDATION", errors: errors.slice(0, 5) });
      // still return normalized prefs; engines can proceed with best-effort
    }

    sources.push(...buildSourcesList(household, user, storePrefs));
    return { ok, prefs: normalized, sources };
  } catch (err) {
    emit("prefs.error", {
      reason: "LOAD",
      message: err?.message || "load failed",
    });
    return { ok: false, prefs: { ...DEFAULTS }, sources };
  }
}

/**
 * Resolve domain-specific preference view for a single import item.
 * Example outputs:
 *  - recipe: doneness target, spiceTolerance, method exclusions, allergens.
 *  - cleaning: scentFamily, chemical constraints, petSafeOnly.
 *  - garden: organicOnly, wateringWindow.
 *
 * @param {Object} args
 * @param {Object} args.item - normalized import item
 * @param {Preferences} args.prefs - fully merged preferences (from load())
 * @returns {{ domain: string, applied: object, advisories: string[] }}
 */
export function resolveForImport({ item, prefs }) {
  const domain = (item?.domain || "").toLowerCase();
  const advisories = [];

  if (!prefs || !domain) {
    return { domain, applied: {}, advisories: ["No prefs or domain provided"] };
  }

  let applied = {};
  switch (domain) {
    case "recipe": {
      const proteinKey = inferProtein(item);
      const doneness =
        pick(prefs.recipe?.doneness, proteinKey) ||
        prefs.recipe?.doneness?.beef ||
        "medium";
      const spiceLevel = prefs.recipe?.spiceTolerance || "medium";
      const avoidMethods = Array.isArray(prefs.recipe?.avoidMethods)
        ? prefs.recipe.avoidMethods
        : [];

      // Allergy advisories
      const allergens = Array.isArray(prefs.core?.dietary?.allergies)
        ? prefs.core.dietary.allergies
        : [];
      const ingredientHits = (item.items || [])
        .map((x) => String(x?.name || "").toLowerCase())
        .filter((n) =>
          allergens.some((a) => n.includes(String(a).toLowerCase()))
        );
      if (ingredientHits.length)
        advisories.push(`Allergen flagged: ${ingredientHits.join(", ")}`);

      // Method advisories
      const methodHits = (item.methods || []).filter((m) =>
        avoidMethods.some((am) =>
          String(m).toLowerCase().includes(String(am).toLowerCase())
        )
      );
      if (methodHits.length)
        advisories.push(`Method discouraged: ${methodHits.join(", ")}`);

      applied = {
        doneness,
        spiceTolerance: spiceLevel,
        oilPreference: prefs.recipe?.oilPreference || "neutral",
        avoidMethods,
        saltLimit: prefs.core?.dietary?.sodiumLimitMgPerDay || null,
      };
      break;
    }

    case "cleaning": {
      applied = {
        scentFamily: prefs.cleaning?.scentFamily || "unscented",
        bleachAllowed: !!prefs.cleaning?.bleachAllowed,
        ammoniaAllowed: !!prefs.cleaning?.ammoniaAllowed,
        petSafeOnly: !!prefs.cleaning?.petSafeOnly,
        sanitizerContactMin: toInt(prefs.cleaning?.sanitizerContactMin, 10),
        surfaces: prefs.cleaning?.surfaces || {},
      };
      if (applied.bleachAllowed && applied.ammoniaAllowed) {
        advisories.push("Never mix bleach and ammonia.");
      }
      break;
    }

    case "garden": {
      applied = {
        organicOnly: !!prefs.garden?.organicOnly,
        pollinatorSafe: !!prefs.garden?.pollinatorSafe,
        wateringWindow: Array.isArray(prefs.garden?.wateringWindow)
          ? prefs.garden.wateringWindow
          : null,
        composting: prefs.garden?.composting || { enabled: true },
      };
      break;
    }

    case "animal": {
      applied = {
        feedBrandsPreferred: prefs.animal?.feedBrandsPreferred || [],
        treatsLimitPerDay: toInt(prefs.animal?.treatsLimitPerDay, 2),
        rawFoodAllowed: !!prefs.animal?.rawFoodAllowed,
      };
      break;
    }

    case "preservation": {
      applied = {
        jarSizeDefaultMl: toInt(prefs.preservation?.jarSizeDefaultMl, 500),
        pectinPreferred: prefs.preservation?.pectinPreferred || "low-sugar",
      };
      break;
    }

    default: {
      applied = {};
      advisories.push(`No domain-specific preferences for ${domain}`);
    }
  }

  emit("prefs.resolved", { domain, appliedKeys: Object.keys(applied) });
  return { domain, applied, advisories };
}

/**
 * Retrieve a single preference by path (e.g., "recipe.spiceTolerance").
 * @param {Preferences} prefs
 * @param {string} path
 * @param {any} fallback
 */
export function get(prefs, path, fallback = undefined) {
  return pathGet(prefs, path, fallback);
}

/**
 * Set an in-memory runtime override (does not persist).
 * @param {string} path - e.g., "cleaning.scentFamily"
 * @param {any} value
 */
export function setRuntimeOverride(path, value) {
  if (!path || typeof path !== "string") return;
  RUNTIME_OVERRIDES[path] = value;
}

/**
 * Register/override a domain schema.
 * @param {string} domain
 * @param {object} schema
 */
export function registerSchema(domain, schema) {
  if (!domain || typeof schema !== "object") return;
  SCHEMAS.set(String(domain).toLowerCase(), schema);
}

/**
 * Register a value normalizer for a fully-qualified preference key.
 * @param {string} key - e.g., "recipe.spiceTolerance"
 * @param {(value:any)=>any} fn
 */
export function registerNormalizer(key, fn) {
  if (!key || typeof fn !== "function") return;
  NORMALIZERS.set(key, fn);
}

// ───────────────────────────────────────────────────────────────────────────────
// Internal — load/normalize/validate

function overridesAsTree(map) {
  // Convert dot-path overrides into nested object tree for deepMerge
  const root = {};
  for (const [path, value] of Object.entries(map)) {
    pathSet(root, path, value);
  }
  return root;
}

function normalizeAll(prefs) {
  const out = deepClone(prefs);
  // Walk normalizers
  for (const [key, fn] of NORMALIZERS.entries()) {
    const current = pathGet(out, key);
    if (current !== undefined) {
      const next = safeNormalize(fn, current);
      pathSet(out, key, next);
    }
  }
  return out;
}

function validateAll(prefs) {
  const errors = [];
  for (const [domain, schema] of SCHEMAS.entries()) {
    const value = prefs[domain] ?? {};
    const ok = validateAgainstSchema(value, schema, `/${domain}`, errors);
    if (!ok) {
      // continue; we collect errors but do not throw
    }
  }
  return { ok: errors.length === 0, errors };
}

// Very small schema validator (type/enums/objects/arrays only)
function validateAgainstSchema(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return true;

  // enum
  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: expected one of ${schema.enum.join(", ")}`);
      return false;
    }
    return true;
  }

  // type union
  if (Array.isArray(schema.type)) {
    if (!schema.type.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected type ${schema.type.join("|")}`);
      return false;
    }
  } else if (schema.type) {
    if (!matchesType(value, schema.type)) {
      errors.push(`${path}: expected type ${schema.type}`);
      return false;
    }
  }

  // object properties
  if (
    schema.type === "object" &&
    schema.properties &&
    value &&
    typeof value === "object"
  ) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (value[k] === undefined) continue; // optional by default
      validateAgainstSchema(value[k], sub, `${path}/${k}`, errors);
    }
  }

  // arrays: light validation
  if (schema.type === "array" && Array.isArray(value)) {
    // pass (no item type enforcement for brevity)
  }
  return true;
}

function matchesType(value, t) {
  if (t === "null") return value === null;
  if (t === "array") return Array.isArray(value);
  return typeof value === t;
}

// ───────────────────────────────────────────────────────────────────────────────
// Domain helpers

function inferProtein(item) {
  const names = (item.items || []).map((x) =>
    String(x?.name || "").toLowerCase()
  );
  if (names.some((n) => /chicken|turkey|poultry/.test(n))) return "chicken";
  if (names.some((n) => /beef|steak|ground beef|brisket/.test(n)))
    return "beef";
  if (names.some((n) => /pork|ham|bacon/.test(n))) return "pork";
  if (names.some((n) => /lamb|mutton/.test(n))) return "lamb";
  if (names.some((n) => /salmon|cod|tilapia|fish|tuna/.test(n))) return "fish";
  if (names.some((n) => /egg/.test(n))) return "egg";
  return "beef";
}

// ───────────────────────────────────────────────────────────────────────────────
// Small utilities

function emit(type, data) {
  try {
    eventBus.emit("automation.event", {
      type,
      ts: new Date().toISOString(),
      source: SOURCE,
      data,
    });
  } catch {
    /* never throw */
  }
}

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch {
    return null;
  }
}

async function tryCall(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function pathGet(obj, path, fallback) {
  if (!obj || !path) return fallback;
  const segs = String(path).split(".");
  let cur = obj;
  for (const s of segs) {
    if (cur == null) return fallback;
    cur = cur[s];
  }
  return cur === undefined ? fallback : cur;
}

function pathSet(obj, path, value) {
  const segs = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const k = segs[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
}

function deepMerge(target, ...sources) {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (!target[k] || typeof target[k] !== "object") target[k] = {};
        deepMerge(target[k], v);
      } else {
        target[k] = Array.isArray(v) ? v.slice() : v;
      }
    }
  }
  return target;
}

function deepClone(v) {
  if (v && typeof v === "object") return JSON.parse(JSON.stringify(v));
  return v;
}

function oneOf(v, list, fallback) {
  const s = String(v || "").toLowerCase();
  return list.includes(s) ? s : fallback;
}

function mapAlias(v, map) {
  const s = String(v || "").toLowerCase();
  return map[s] || s;
}

function toInt(n, fallback) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? x : fallback;
}

// ───────────────────────────────────────────────────────────────────────────────
// Types (JSDoc)
/**
 * @typedef {object} Preferences
 * @property {object} core
 * @property {object} recipe
 * @property {object} cleaning
 * @property {object} garden
 * @property {object} animal
 * @property {object} preservation
 */

// ───────────────────────────────────────────────────────────────────────────────

export default {
  load,
  resolveForImport,
  get,
  setRuntimeOverride,
  registerSchema,
  registerNormalizer,
};
