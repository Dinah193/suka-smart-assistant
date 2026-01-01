// C:\Users\larho\suka-smart-assistant\src\shared\ontology.js
/**
 * Suka Shared Ontology (dynamic, extensible)
 * ------------------------------------------
 * A single source of truth for domain terms, categories, and lightweight schemas
 * that all agents/services can share. Designed to run in browser or Node.
 *
 * Goals this serves:
 * - Consistent labels & categories across cooking/cleaning/gardening/animals/inventory
 * - Intuitive synonym → canonical term normalization
 * - Validation/type-guards for orchestrator, agents, and detectors
 * - Schedules & daypart semantics, Sabbath-aware hints
 * - Extensible: project- or user-specific overlays can be merged at runtime
 *
 * How to extend at runtime (anywhere, before importing this module):
 *   // Browser:
 *   window.__SUKA_ONTOLOGY__ = { domains: { custom: { label: "Custom", synonyms: ["x"] } } }
 *
 *   // Node/SSR (optional local overlay file if present):
 *   // Create src/shared/ontology.local.js that default-exports a partial ontology object.
 *
 * Consumers:
 *   import Ont, { normalizeTerm, classifyText, isDomain } from "@/shared/ontology";
 */

const VERSION = "2025.09.08";

/* ------------------------------------------------------------------------------------------
 * Utilities (safe env detection, deep merge, etc.)
 * ----------------------------------------------------------------------------------------*/
const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";

function deepMerge(target, source) {
  if (!source) return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(target?.[k] || {}, v);
    } else if (Array.isArray(v)) {
      // Merge arrays by value (unique)
      const base = Array.isArray(target?.[k]) ? target[k] : [];
      const set = new Set([...base, ...v]);
      out[k] = [...set];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function uniq(arr) { return Array.from(new Set(arr || [])); }
function toKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------------------------------
 * Base Ontology
 * ----------------------------------------------------------------------------------------*/

const BASE = {
  version: VERSION,

  // Domains are “top-level” spheres of activity.
  domains: {
    general:       { label: "General", synonyms: ["misc", "other"] },
    cooking:       { label: "Cooking", synonyms: ["cook", "kitchen", "meal", "batch"] },
    cleaning:      { label: "Cleaning", synonyms: ["tidy", "sanitize", "housekeeping"] },
    gardening:     { label: "Gardening", synonyms: ["garden", "planting", "harvest"] },
    animals:       { label: "Animal Care", synonyms: ["farm", "livestock", "coop", "kennel", "pen"] },
    inventory:     { label: "Inventory", synonyms: ["stock", "storehouse", "supplies"] },
    preservation:  { label: "Preservation", synonyms: ["canning", "ferment", "freezing", "dehydrate"] },
    mealPlanning:  { label: "Meal Planning", synonyms: ["menu", "planner", "meals"] },
    calendar:      { label: "Calendar", synonyms: ["events", "schedule", "appointments"] },
    sabbath:       { label: "Sabbath", synonyms: ["shabbat", "saturday-avoidance"] },
  },

  // Roles map to “workerSessions.role” and agent viewpoints.
  roles: {
    cleaner:   { label: "Cleaner", synonyms: ["cleaning", "housekeeper"] },
    cook:      { label: "Cook", synonyms: ["chef", "kitchen"] },
    gardener:  { label: "Gardener", synonyms: ["grower", "planter"] },
    animaler:  { label: "Animal Keeper", synonyms: ["farmer", "herder", "livestock"] },
    parent:    { label: "Parent", synonyms: ["caregiver"] },
    host:      { label: "Host", synonyms: ["entertainer"] },
  },

  // Zones (used by cleaning routines & UI).
  zones: {
    Kitchen: { label: "Kitchen", synonyms: ["kitchen", "galley"], frequencyDays: 2 },
    Bath:    { label: "Bathroom", synonyms: ["bath", "restroom"], frequencyDays: 3 },
    Entry:   { label: "Entry", synonyms: ["foyer", "mudroom"], frequencyDays: 4 },
    Living:  { label: "Living Room", synonyms: ["living", "lounge"], frequencyDays: 4 },
    Bedroom: { label: "Bedroom", synonyms: ["bed", "sleep"], frequencyDays: 5 },
    Laundry: { label: "Laundry", synonyms: ["utility"], frequencyDays: 4 },
    Fridge:  { label: "Fridge", synonyms: ["refrigerator"], frequencyDays: 7 },
    Freezer: { label: "Freezer", synonyms: ["deep-freeze"], frequencyDays: 14 },
    Pantry:  { label: "Pantry", synonyms: ["storehouse"], frequencyDays: 14 },
    Garden:  { label: "Garden", synonyms: ["yard", "beds"], frequencyDays: 3 },
    Animals: { label: "Animals", synonyms: ["coop", "pen", "kennel", "barn"], frequencyDays: 1 },
  },

  // Categories for inventory/supplies/ingredients.
  categories: {
    cleaning:   { label: "Cleaning Supplies", synonyms: ["cleaners", "detergents"] },
    pantry:     { label: "Pantry", synonyms: ["dry-goods", "staples"] },
    produce:    { label: "Produce", synonyms: ["vegetables", "fruit"] },
    meat:       { label: "Meat", synonyms: ["protein", "butchery"] },
    dairy:      { label: "Dairy", synonyms: ["milk", "cheese", "yogurt"] },
    canning:    { label: "Canning", synonyms: ["mason-jars", "lids", "rings"] },
    preservation:{ label: "Preservation", synonyms: ["ferment", "dehydrate"] },
  },

  // Trigger types (aligned with detectors).
  triggers: {
    SUPPLY_LOW:       { label: "Supply Low", domains: ["inventory", "cleaning"] },
    SUPPLY_OVERDUE:   { label: "Supply Overdue", domains: ["inventory", "cleaning"] },
    ZONE_OVERDUE:     { label: "Zone Overdue", domains: ["cleaning"] },
    GARDEN_HARVEST:   { label: "Harvest Window", domains: ["gardening"] },
    GARDEN_PLANTING:  { label: "Planting Window", domains: ["gardening"] },
  },

  // Event names (keep in sync with householdOrchestrator FALLBACK_EVENTS).
  events: {
    SESSION: {
      PLANNED: {
        COOKING:   "SESSION.PLANNED.COOKING",
        CLEANING:  "SESSION.PLANNED.CLEANING",
        GARDENING: "SESSION.PLANNED.GARDENING",
      },
      STARTED: {
        COOKING:   "SESSION.STARTED.COOKING",
        CLEANING:  "SESSION.STARTED.CLEANING",
        GARDENING: "SESSION.STARTED.GARDENING",
      },
      FINISHED: {
        COOKING:   "SESSION.FINISHED.COOKING",
        CLEANING:  "SESSION.FINISHED.CLEANING",
        GARDENING: "SESSION.FINISHED.GARDENING",
      },
    },
    INVENTORY: {
      SURPLUS:  "INVENTORY.SURPLUS.DETECTED",
      LOW:      "INVENTORY.LOW.DETECTED",
      RESERVED: "INVENTORY.RESERVED",
      DEDUCTED: "INVENTORY.DEDUCTED",
    },
    GARDEN: {
      HARVEST_WINDOW:  "GARDEN.HARVEST.WINDOW",
      PLANTING_WINDOW: "GARDEN.PLANTING.WINDOW",
      PEST_RISK:       "GARDEN.PEST.RISK",
    },
    WEATHER: {
      FROST_ALERT: "WEATHER.FROST.ALERT",
      HEAT_ALERT:  "WEATHER.HEAT.ALERT",
      RAIN_WINDOW: "WEATHER.RAIN.WINDOW",
    },
    DAY: {
      MORNING:   "DAY.MORNING",
      AFTERNOON: "DAY.AFTERNOON",
      EVENING:   "DAY.EVENING",
    },
    SABBATH: {
      PREP:  "SABBATH.PREP.WINDOW",
      START: "SABBATH.START",
      END:   "SABBATH.END",
    },
  },

  // Simple units (for lightweight conversion/normalization).
  units: {
    time: {
      min: 60_000,
      hr:  3_600_000,
      day: 86_400_000,
    },
    mass: {
      g: 1,
      kg: 1000,
      lb: 453.59237,
      oz: 28.349523125,
    },
    volume: {
      ml: 1,
      l: 1000,
      cup: 240,
      tbsp: 15,
      tsp: 5,
      floz: 29.5735,
      gal: 3785.41,
    },
  },

  // Canonical verbs we care about for classification
  verbs: {
    cooking:   ["chop", "bake", "boil", "sear", "marinate", "soak", "prep", "batch"],
    cleaning:  ["wipe", "scrub", "sanitize", "mop", "dust", "declutter", "vacuum"],
    gardening: ["plant", "sow", "weed", "harvest", "mulch", "prune", "irrigate"],
    animals:   ["feed", "milk", "butcher", "deworm", "shear", "hoof-trim"],
    inventory: ["restock", "deduct", "reserve", "audit"],
  },

  // JSON-LD context (for LLM-friendly knowledge graphs / export)
  context: {
    "@context": {
      "@vocab": "https://suka.local/schema#",
      id: "@id",
      type: "@type",
      name: "schema:name",
      domain: "suka:domain",
      role: "suka:role",
      zone: "suka:zone",
      event: "suka:event",
      trigger: "suka:trigger",
      category: "suka:category",
      status: "schema:status",
      start: "schema:startTime",
      end: "schema:endTime",
      due: "schema:dueDate",
      quantity: "schema:amount",
      unit: "schema:unitCode",
    },
  },
};

/* ------------------------------------------------------------------------------------------
 * Synonyms Index (built from BASE)
 * ----------------------------------------------------------------------------------------*/
function buildSynonymIndex(base) {
  const idx = new Map();

  function addSyn(key, canonical) {
    const k = toKey(key);
    if (!k) return;
    if (!idx.has(k)) idx.set(k, canonical);
  }

  // Domains
  Object.entries(base.domains).forEach(([canon, def]) => {
    addSyn(canon, { type: "domain", value: canon });
    (def.synonyms || []).forEach((s) => addSyn(s, { type: "domain", value: canon }));
  });
  // Roles
  Object.entries(base.roles).forEach(([canon, def]) => {
    addSyn(canon, { type: "role", value: canon });
    (def.synonyms || []).forEach((s) => addSyn(s, { type: "role", value: canon }));
  });
  // Zones
  Object.entries(base.zones).forEach(([canon, def]) => {
    addSyn(canon, { type: "zone", value: canon });
    (def.synonyms || []).forEach((s) => addSyn(s, { type: "zone", value: canon }));
  });
  // Categories
  Object.entries(base.categories).forEach(([canon, def]) => {
    addSyn(canon, { type: "category", value: canon });
    (def.synonyms || []).forEach((s) => addSyn(s, { type: "category", value: canon }));
  });

  return idx;
}

/* ------------------------------------------------------------------------------------------
 * Sabbath Helpers (simple, overridable)
 * ----------------------------------------------------------------------------------------*/
function computeSabbathWindow(now = new Date()) {
  // Default policy: Saturday avoidance; start/end approximated to 6pm local Fri/Sat.
  const day = now.getDay(); // 0=Sun..6=Sat
  const daysToFri = (5 - day + 7) % 7;
  const daysToSat = (6 - day + 7) % 7;
  const fri = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToFri, 18, 0, 0, 0);
  const sat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToSat, 18, 0, 0, 0);
  return { startISO: fri.toISOString(), endISO: sat.toISOString() };
}

/* ------------------------------------------------------------------------------------------
 * Classifiers / Normalizers
 * ----------------------------------------------------------------------------------------*/
function normalizeTerm(s, index) {
  const k = toKey(s);
  if (!k) return null;
  return index.get(k) || null;
}

function classifyText(text, base, index) {
  const t = toKey(text);
  if (!t) return { domain: "general", roles: [], zones: [], categories: [] };

  // If a direct synonym matches a domain/role/zone/category, prefer it
  const direct = normalizeTerm(t, index);
  if (direct) {
    if (direct.type === "domain") return { domain: direct.value, roles: [], zones: [], categories: [] };
  }

  // Heuristic scanning using verbs & token presence
  const score = {};
  Object.keys(base.domains).forEach((d) => (score[d] = 0));

  // verbs
  Object.entries(base.verbs).forEach(([domain, verbs]) => {
    verbs.forEach((v) => {
      if (t.includes(toKey(v))) score[domain] += 2;
    });
  });

  // zones as hints
  Object.entries(base.zones).forEach(([z, def]) => {
    if (t.includes(toKey(z)) || (def.synonyms || []).some((s) => t.includes(toKey(s)))) {
      score.cleaning += 1; // zones often correlate with cleaning
    }
  });

  // categories as hints (inventory/cooking bias)
  Object.entries(base.categories).forEach(([c, def]) => {
    if (t.includes(toKey(c)) || (def.synonyms || []).some((s) => t.includes(toKey(s)))) {
      score.inventory += 1;
      if (["pantry", "produce", "meat", "dairy"].includes(c)) score.cooking += 1;
    }
  });

  // pick max
  const top = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  const domain = top && top[1] > 0 ? top[0] : "general";

  // roles, zones, categories mentions (non-exclusive)
  const roles = Object.entries(base.roles)
    .filter(([_, def]) => t.includes(toKey(_) ) || (def.synonyms || []).some((s) => t.includes(toKey(s))))
    .map(([k]) => k);

  const zones = Object.entries(base.zones)
    .filter(([_, def]) => t.includes(toKey(_) ) || (def.synonyms || []).some((s) => t.includes(toKey(s))))
    .map(([k]) => k);

  const categories = Object.entries(base.categories)
    .filter(([_, def]) => t.includes(toKey(_) ) || (def.synonyms || []).some((s) => t.includes(toKey(s))))
    .map(([k]) => k);

  return {
    domain,
    roles: uniq(roles),
    zones: uniq(zones),
    categories: uniq(categories),
  };
}

/* ------------------------------------------------------------------------------------------
 * Validation / Type Guards
 * ----------------------------------------------------------------------------------------*/
function isDomain(base, v) { return !!base.domains?.[v]; }
function isRole(base, v) { return !!base.roles?.[v]; }
function isZone(base, v) { return !!base.zones?.[v]; }
function isCategory(base, v) { return !!base.categories?.[v]; }
function isEvent(base, v) {
  const E = base.events || {};
  return Object.values(E).some((x) =>
    typeof x === "string" ? x === v : Object.values(x).some((y) =>
      typeof y === "string" ? y === v : Object.values(y).includes(v)
    )
  );
}

/* ------------------------------------------------------------------------------------------
 * Unit Helpers
 * ----------------------------------------------------------------------------------------*/
function convertUnit(unitsTable, from, to, value) {
  const a = unitsTable[from];
  const b = unitsTable[to];
  if (!a || !b) return null;
  return (value * a) / b;
}
function convertTime(value, from, to) { return convertUnit(BASE.units.time, from, to, value); }
function convertMass(value, from, to) { return convertUnit(BASE.units.mass, from, to, value); }
function convertVolume(value, from, to) { return convertUnit(BASE.units.volume, from, to, value); }

/* ------------------------------------------------------------------------------------------
 * Dynamic Overlay (browser global & optional local module)
 * ----------------------------------------------------------------------------------------*/
let _cached = null;

function _applyOverlay(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  return deepMerge(base, overlay);
}

/**
 * Load dynamic overlays:
 *  1) Browser global window.__SUKA_ONTOLOGY__
 *  2) Optional local file src/shared/ontology.local.js exporting default overlay
 */
function _loadDynamic() {
  let out = { ...BASE };

  // Browser overlay
  if (isBrowser && window.__SUKA_ONTOLOGY__) {
    out = _applyOverlay(out, window.__SUKA_ONTOLOGY__);
  }

  // Local overlay (CommonJS safe require)
  try {
    // eslint-disable-next-line global-require
    const local = require("./ontology.local.js");
    const overlay = local?.default || local;
    if (overlay) out = _applyOverlay(out, overlay);
  } catch {
    // optional
  }

  return out;
}

/**
 * Get the live ontology (cached until explicit refresh).
 */
function getOntology() {
  if (_cached) return _cached;
  const live = _loadDynamic();
  const index = buildSynonymIndex(live);
  _cached = { base: live, index };
  return _cached;
}

/** Force reload overlays (useful in dev or after user settings change) */
function refreshOntology() {
  _cached = null;
  return getOntology();
}

/* ------------------------------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------------------------*/
function normalize(input) {
  const { base, index } = getOntology();
  const hit = normalizeTerm(input, index);
  if (hit) return hit;
  // If not found, attempt a domain guess from classification
  const cls = classifyText(String(input || ""), base, index);
  return { type: "domain", value: cls.domain };
}

/**
 * classify(text) → { domain, roles[], zones[], categories[] }
 * Uses dynamic ontology each time (cached structures internally).
 */
function classify(text) {
  const { base, index } = getOntology();
  return classifyText(text, base, index);
}

/**
 * sabbath(now?) → { startISO, endISO }
 * Can be replaced/overlaid by local file to use precise sunset calculations.
 */
function sabbath(now) {
  // If local overlay provided custom function, prefer it
  try {
    // eslint-disable-next-line global-require
    const local = require("./ontology.local.js");
    const f = local?.sabbath || local?.default?.sabbath;
    if (typeof f === "function") return f(now);
  } catch {}
  return computeSabbathWindow(now);
}

/* ------------------------------------------------------------------------------------------
 * Module Exports (CJS + ESM interop)
 * ----------------------------------------------------------------------------------------*/
const exported = {
  VERSION,

  // accessors
  getOntology,
  refreshOntology,

  // base facets (read-only snapshot)
  get base() { return getOntology().base; },
  get index() { return getOntology().index; },

  // helpers
  normalizeTerm: (s) => normalizeTerm(s, getOntology().index),
  normalize,
  classify,

  // units
  convertTime,
  convertMass,
  convertVolume,

  // validators
  isDomain: (v) => isDomain(getOntology().base, v),
  isRole: (v) => isRole(getOntology().base, v),
  isZone: (v) => isZone(getOntology().base, v),
  isCategory: (v) => isCategory(getOntology().base, v),
  isEvent: (v) => isEvent(getOntology().base, v),

  // sabbath helper
  sabbath,

  // raw constants (if you need)
  EVENTS: BASE.events,
};

module.exports = exported;
module.exports.default = exported;
