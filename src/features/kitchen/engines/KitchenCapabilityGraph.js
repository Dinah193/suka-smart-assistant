/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\kitchen\engines\KitchenCapabilityGraph.js
//
// SSA • KitchenCapabilityGraph
// -----------------------------------------------------------------------------
// Deterministic, explainable mapping: equipment -> capabilities.
//
// Why this exists:
// - Recipes and session plans need to know what the household can *actually* do
//   with the tools they have (cutting, blending, baking, fermentation control, etc.).
// - Adaptation pipelines (RecipeAdapterService) need a fast way to:
//   1) infer household capabilities from equipment,
//   2) check whether a recipe step is feasible,
//   3) propose substitutions / alternatives, with "why" explanations.
//
// Design goals:
// - Browser-safe (no Node APIs)
// - Deterministic, explainable output
// - Accepts "canonical" catalogs but tolerates partial / legacy records
// - Supports capability "levels" (e.g., OVEN: convection > standard)
// - Emits structured evidence: which equipment granted a capability, and why
//
// Expected inputs (SSA style):
// - equipment catalog: "@/features/kitchen/catalogs/equipment.catalog.js"
// - (optional) capability definitions schema/catalog: "@/features/kitchen/contracts/kitchen.capabilities.schema.js"
//   (used here only for optional enrichment / normalization hints)
//
// NOTE:
// This module does not mutate catalogs. It builds a computed graph for querying.
// -----------------------------------------------------------------------------
//
// Public API:
// - KitchenCapabilityGraph.build({ equipmentCatalog, capabilityCatalog, householdEquipment, options })
// - KitchenCapabilityGraph.fromHousehold({ householdId, equipmentCatalog, capabilityCatalog, householdEquipment, options })
// - KitchenCapabilityGraph.getCapabilitiesForEquipment(equipmentId)
// - KitchenCapabilityGraph.getEquipmentForCapability(capabilityId, { minLevel })
// - KitchenCapabilityGraph.getHouseholdCapabilities({ householdEquipment, includeEvidence })
// - KitchenCapabilityGraph.explainCapability(capabilityId)
// - KitchenCapabilityGraph.checkRequirements(requirements, { householdEquipment })
// - KitchenCapabilityGraph.diffHouseholdVsRequirements(requirements, { householdEquipment })
//
// -----------------------------------------------------------------------------
// Capability model conventions (recommended):
// capabilityId: "CUTTING_BOARD", "KNIFE_CHEF", "HEAT_OVEN", "HEAT_STOVETOP",
//               "BLEND_IMMERSION", "MIXER_STAND", "FERMENT_TEMP_CONTROL", ...
//
// Equipment model conventions (recommended):
// equipmentId: "OVEN_STANDARD", "OVEN_CONVECTION", "STOVETOP_GAS", "BLENDER_COUNTERTOP", ...
//
// Equipment record may include any of these fields (we normalize):
// { id, label, type, tags, providesCapabilities, capabilities, provides, grants }
//
// Each provided capability can be a string ("HEAT_OVEN") or an object:
// { id:"HEAT_OVEN", level:2, notes:"convection", weight:1, when:{...} }
//
// -----------------------------------------------------------------------------
// Requirements shape supported:
// - Array of strings: ["HEAT_OVEN", "KNIFE_CHEF"]
// - Array of objects: [{ id:"HEAT_OVEN", minLevel:1 }, { id:"MIXER_STAND", minLevel:2 }]
// - Or a single object:
//   { allOf:[...], anyOf:[...], noneOf:[...], notes:"..." }
//
// -----------------------------------------------------------------------------
//
// SSA-friendly output shapes:
// HouseholdCapabilities:
// {
//   capabilities: {
//     HEAT_OVEN: { level: 2, sources:[...evidence], label, category }
//   },
//   evidenceByEquipment: {
//     OVEN_CONVECTION: [{capabilityId, level, ...}, ...]
//   },
//   meta: { generatedAt, options, stats }
// }
//
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} CapabilityGrant
 * @property {string} capabilityId
 * @property {number} level
 * @property {number} weight
 * @property {string=} notes
 * @property {Object=} when
 * @property {Object=} extra
 */

/**
 * @typedef {Object} EquipmentRecordNormalized
 * @property {string} id
 * @property {string} label
 * @property {string=} type
 * @property {string[]=} tags
 * @property {CapabilityGrant[]} grants
 * @property {Object=} raw
 */

/**
 * @typedef {Object} CapabilityDefinition
 * @property {string} id
 * @property {string=} label
 * @property {string=} category
 * @property {string[]=} aliases
 * @property {number=} maxLevel
 * @property {string=} description
 */

/** @typedef {{[capabilityId:string]: { level:number, sources:any[], def?:CapabilityDefinition }}} CapabilityIndex */
/** @typedef {{[equipmentId:string]: EquipmentRecordNormalized}} EquipmentIndex */

const DEFAULTS = Object.freeze({
  debug: false,
  strict: false, // if true: throw on malformed catalog entries
  preferCapabilityCatalogLabels: true,
  defaultLevel: 1,
  defaultWeight: 1,
  // If a grant declares a level > maxLevel (from definition), clamp it:
  clampToMaxLevel: true,
});

function nowISO() {
  try {
    return new Date().toISOString();
  } catch {
    return "unknown";
  }
}

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function toArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function safeLower(s) {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const k = typeof v === "string" ? v : JSON.stringify(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

function logDebug(debug, ...args) {
  if (debug) console.log("[KitchenCapabilityGraph]", ...args);
}

function normalizeCapabilityId(id, aliasIndex) {
  if (!id || typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;

  // Prefer exact match first
  if (aliasIndex && aliasIndex[trimmed]) return aliasIndex[trimmed];

  // Try case-insensitive alias match
  const lower = trimmed.toLowerCase();
  if (aliasIndex && aliasIndex.__lower && aliasIndex.__lower[lower])
    return aliasIndex.__lower[lower];

  return trimmed;
}

function buildAliasIndex(capabilityCatalog) {
  // aliasIndex: { "ALIAS": "CANONICAL", "__lower": { "alias": "CANONICAL" } }
  const aliasIndex = { __lower: Object.create(null) };

  const defs = normalizeCapabilityCatalog(capabilityCatalog).list;
  for (const def of defs) {
    if (!def || !def.id) continue;

    // Map the id to itself
    aliasIndex[def.id] = def.id;
    aliasIndex.__lower[safeLower(def.id)] = def.id;

    for (const a of toArray(def.aliases)) {
      if (!a || typeof a !== "string") continue;
      aliasIndex[a] = def.id;
      aliasIndex.__lower[safeLower(a)] = def.id;
    }
  }
  return aliasIndex;
}

function normalizeCapabilityCatalog(capabilityCatalog) {
  // Accept formats:
  // - { capabilities:[{id,...}] }
  // - { list:[{id,...}] }
  // - [{id,...}]
  // - { byId:{ CAP:{...} } }
  const out = {
    byId: Object.create(null),
    list: [],
  };

  if (!capabilityCatalog) return out;

  let list = [];
  if (Array.isArray(capabilityCatalog)) list = capabilityCatalog;
  else if (Array.isArray(capabilityCatalog.capabilities))
    list = capabilityCatalog.capabilities;
  else if (Array.isArray(capabilityCatalog.list)) list = capabilityCatalog.list;
  else if (isPlainObject(capabilityCatalog.byId))
    list = Object.values(capabilityCatalog.byId);
  else if (isPlainObject(capabilityCatalog.defs))
    list = Object.values(capabilityCatalog.defs);

  for (const item of list) {
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id.trim() : null;
    if (!id) continue;
    const def = {
      id,
      label: typeof item.label === "string" ? item.label : undefined,
      category: typeof item.category === "string" ? item.category : undefined,
      aliases: Array.isArray(item.aliases)
        ? item.aliases.filter((x) => typeof x === "string")
        : undefined,
      maxLevel: Number.isFinite(item.maxLevel)
        ? Number(item.maxLevel)
        : undefined,
      description:
        typeof item.description === "string" ? item.description : undefined,
    };
    out.byId[id] = def;
    out.list.push(def);
  }

  return out;
}

function normalizeEquipmentCatalog(equipmentCatalog, aliasIndex, options) {
  // Accept formats:
  // - [{id,label,...}]
  // - { tools:[...]} or { equipment:[...]} or { list:[...]} or { byId:{...} }
  const debug = !!options?.debug;
  const strict = !!options?.strict;

  let list = [];
  if (!equipmentCatalog) list = [];
  else if (Array.isArray(equipmentCatalog)) list = equipmentCatalog;
  else if (Array.isArray(equipmentCatalog.equipment))
    list = equipmentCatalog.equipment;
  else if (Array.isArray(equipmentCatalog.tools)) list = equipmentCatalog.tools;
  else if (Array.isArray(equipmentCatalog.list)) list = equipmentCatalog.list;
  else if (isPlainObject(equipmentCatalog.byId))
    list = Object.values(equipmentCatalog.byId);

  /** @type {EquipmentIndex} */
  const byId = Object.create(null);

  for (const raw of list) {
    if (!raw) continue;

    const id = typeof raw.id === "string" ? raw.id.trim() : null;
    if (!id) {
      if (strict) throw new Error("Equipment record missing id");
      logDebug(debug, "Skipping equipment without id:", raw);
      continue;
    }

    const label =
      typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;

    // Normalize grants
    // Supported fields: providesCapabilities, capabilities, provides, grants
    const grantsRaw =
      raw.providesCapabilities ??
      raw.capabilities ??
      raw.provides ??
      raw.grants ??
      raw.provides_capabilities ??
      raw.capabilityGrants ??
      [];

    const grants = normalizeGrants(grantsRaw, aliasIndex, options, {
      equipmentId: id,
      equipmentLabel: label,
    });

    byId[id] = {
      id,
      label,
      type: typeof raw.type === "string" ? raw.type : undefined,
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((x) => typeof x === "string")
        : undefined,
      grants,
      raw,
    };
  }

  return byId;
}

function normalizeGrants(grantsRaw, aliasIndex, options, ctx) {
  const debug = !!options?.debug;
  const strict = !!options?.strict;
  const defaultLevel = Number.isFinite(options?.defaultLevel)
    ? Number(options.defaultLevel)
    : DEFAULTS.defaultLevel;
  const defaultWeight = Number.isFinite(options?.defaultWeight)
    ? Number(options.defaultWeight)
    : DEFAULTS.defaultWeight;

  const out = [];

  for (const g of toArray(grantsRaw)) {
    if (!g) continue;

    // String grant: "HEAT_OVEN"
    if (typeof g === "string") {
      const capId = normalizeCapabilityId(g, aliasIndex);
      if (!capId) continue;

      out.push({
        capabilityId: capId,
        level: defaultLevel,
        weight: defaultWeight,
        notes: undefined,
        when: undefined,
        extra: {
          source: "string",
          equipmentId: ctx?.equipmentId,
          equipmentLabel: ctx?.equipmentLabel,
        },
      });
      continue;
    }

    if (!isPlainObject(g)) {
      if (strict)
        throw new Error(
          `Invalid capability grant for equipment ${ctx?.equipmentId}`
        );
      logDebug(debug, "Skipping invalid grant:", ctx?.equipmentId, g);
      continue;
    }

    // Object grant
    const rawId = g.id || g.capabilityId || g.capability || g.key;
    const capId = normalizeCapabilityId(rawId, aliasIndex);
    if (!capId) {
      if (strict)
        throw new Error(
          `Grant missing capability id for equipment ${ctx?.equipmentId}`
        );
      logDebug(
        debug,
        "Skipping grant without capabilityId:",
        ctx?.equipmentId,
        g
      );
      continue;
    }

    const level = Number.isFinite(g.level) ? Number(g.level) : defaultLevel;
    const weight = Number.isFinite(g.weight) ? Number(g.weight) : defaultWeight;

    out.push({
      capabilityId: capId,
      level,
      weight,
      notes:
        typeof g.notes === "string"
          ? g.notes
          : typeof g.note === "string"
          ? g.note
          : undefined,
      when: isPlainObject(g.when) ? g.when : undefined,
      extra: {
        ...("extra" in g && isPlainObject(g.extra) ? g.extra : null),
        source: "object",
        equipmentId: ctx?.equipmentId,
        equipmentLabel: ctx?.equipmentLabel,
      },
    });
  }

  // De-dupe by capabilityId+level+notes to reduce noise
  return uniq(
    out.map((x) => ({
      ...x,
      // canonicalize types
      capabilityId: x.capabilityId,
      level: Number.isFinite(x.level) ? x.level : defaultLevel,
      weight: Number.isFinite(x.weight) ? x.weight : defaultWeight,
    }))
  );
}

function clampLevel(level, def, options) {
  if (!Number.isFinite(level)) return 1;
  const n = Number(level);
  if (!def || !Number.isFinite(def.maxLevel)) return n;
  if (!options?.clampToMaxLevel) return n;
  return Math.max(0, Math.min(n, Number(def.maxLevel)));
}

function isEquipmentEnabled(householdEquipmentEntry) {
  // Accept:
  // - string equipmentId => enabled
  // - { id, enabled } or { equipmentId, enabled } => enabled unless enabled===false
  if (!householdEquipmentEntry) return false;
  if (typeof householdEquipmentEntry === "string") return true;
  if (isPlainObject(householdEquipmentEntry)) {
    if (householdEquipmentEntry.enabled === false) return false;
    return !!(
      householdEquipmentEntry.id || householdEquipmentEntry.equipmentId
    );
  }
  return false;
}

function getEquipmentIdFromEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  if (isPlainObject(entry)) return entry.id || entry.equipmentId || null;
  return null;
}

function buildHouseholdEquipmentIndex(householdEquipment) {
  // Returns { [equipmentId]: { id, enabled, quantity, meta... } }
  const out = Object.create(null);
  for (const entry of toArray(householdEquipment)) {
    const id = getEquipmentIdFromEntry(entry);
    if (!id) continue;
    const enabled = isEquipmentEnabled(entry);
    const quantity =
      isPlainObject(entry) && Number.isFinite(entry.quantity)
        ? Number(entry.quantity)
        : enabled
        ? 1
        : 0;

    out[id] = {
      id,
      enabled,
      quantity,
      ...(isPlainObject(entry) ? entry : null),
    };
  }
  return out;
}

function mergeCapability(current, incoming) {
  // Choose highest level; if tie, accumulate sources
  if (!current) return incoming;
  const bestLevel = Math.max(current.level || 0, incoming.level || 0);
  const sources = []
    .concat(current.sources || [])
    .concat(incoming.sources || []);

  return {
    ...current,
    ...incoming,
    level: bestLevel,
    sources,
  };
}

function normalizeRequirements(req) {
  // Returns { allOf:[], anyOf:[], noneOf:[] }
  if (!req) return { allOf: [], anyOf: [], noneOf: [] };

  if (Array.isArray(req)) {
    return { allOf: req, anyOf: [], noneOf: [] };
  }

  if (typeof req === "string") {
    return { allOf: [req], anyOf: [], noneOf: [] };
  }

  if (isPlainObject(req)) {
    const allOf = req.allOf ?? req.all ?? req.requires ?? req.required ?? [];
    const anyOf = req.anyOf ?? req.any ?? req.oneOf ?? [];
    const noneOf = req.noneOf ?? req.not ?? req.excludes ?? [];

    return {
      allOf: toArray(allOf),
      anyOf: toArray(anyOf),
      noneOf: toArray(noneOf),
    };
  }

  return { allOf: [], anyOf: [], noneOf: [] };
}

function normalizeRequirementAtom(atom) {
  // "HEAT_OVEN" => { id, minLevel:1 }
  // { id:"HEAT_OVEN", minLevel:2 } => same
  if (!atom) return null;
  if (typeof atom === "string") return { id: atom, minLevel: 1 };
  if (isPlainObject(atom)) {
    const id = atom.id || atom.capabilityId || atom.capability;
    if (!id) return null;
    const minLevel = Number.isFinite(atom.minLevel)
      ? Number(atom.minLevel)
      : Number.isFinite(atom.level)
      ? Number(atom.level)
      : 1;
    return { id, minLevel };
  }
  return null;
}

/**
 * KitchenCapabilityGraph factory + query helpers.
 */
export class KitchenCapabilityGraph {
  /**
   * Build a graph from catalogs and optional household equipment.
   * @param {Object} args
   * @param {any} args.equipmentCatalog
   * @param {any=} args.capabilityCatalog
   * @param {Array<string|Object>=} args.householdEquipment
   * @param {Object=} args.options
   */
  static build({
    equipmentCatalog,
    capabilityCatalog,
    householdEquipment,
    options,
  } = {}) {
    const opts = { ...DEFAULTS, ...(options || {}) };
    const debug = !!opts.debug;

    const capCat = normalizeCapabilityCatalog(capabilityCatalog);
    const aliasIndex = buildAliasIndex(capCat);

    const equipmentById = normalizeEquipmentCatalog(
      equipmentCatalog,
      aliasIndex,
      opts
    );
    const defsById = capCat.byId;

    // Build adjacency indexes:
    /** @type {{[equipmentId:string]: CapabilityGrant[]}} */
    const equipmentToGrants = Object.create(null);

    /** @type {{[capabilityId:string]: { equipmentId:string, equipmentLabel:string, level:number, weight:number, notes?:string }[]}} */
    const capabilityToEquipment = Object.create(null);

    for (const [eid, e] of Object.entries(equipmentById)) {
      equipmentToGrants[eid] = e.grants || [];

      for (const grant of e.grants || []) {
        const def = defsById[grant.capabilityId];
        const level = clampLevel(grant.level, def, opts);

        if (!capabilityToEquipment[grant.capabilityId])
          capabilityToEquipment[grant.capabilityId] = [];
        capabilityToEquipment[grant.capabilityId].push({
          equipmentId: eid,
          equipmentLabel: e.label,
          level,
          weight: Number.isFinite(grant.weight)
            ? grant.weight
            : opts.defaultWeight,
          notes: grant.notes,
        });
      }
    }

    // Optionally precompute household capability summary:
    const householdIndex = buildHouseholdEquipmentIndex(householdEquipment);
    const householdOut = this._computeHouseholdCapabilities({
      equipmentById,
      defsById,
      aliasIndex,
      householdIndex,
      opts,
    });

    logDebug(debug, "Graph built:", {
      equipmentCount: Object.keys(equipmentById).length,
      capabilityCount:
        Object.keys(defsById).length ||
        Object.keys(capabilityToEquipment).length,
      householdEquipmentCount: Object.keys(householdIndex).length,
    });

    return {
      kind: "SSA.KitchenCapabilityGraph",
      generatedAt: nowISO(),
      options: opts,

      // catalogs/indexes
      equipmentById,
      capabilityDefsById: defsById,
      aliasIndex,

      // graph edges
      equipmentToGrants,
      capabilityToEquipment,

      // computed household snapshot (if householdEquipment provided)
      household: householdOut,

      // query API bound to this graph
      api: this._bindApi({
        equipmentById,
        defsById,
        aliasIndex,
        equipmentToGrants,
        capabilityToEquipment,
        opts,
      }),
    };
  }

  /**
   * Convenience wrapper when you want the graph in a household context.
   * @param {Object} args
   * @param {string=} args.householdId
   * @param {any} args.equipmentCatalog
   * @param {any=} args.capabilityCatalog
   * @param {Array<string|Object>=} args.householdEquipment
   * @param {Object=} args.options
   */
  static fromHousehold({
    householdId,
    equipmentCatalog,
    capabilityCatalog,
    householdEquipment,
    options,
  } = {}) {
    const graph = this.build({
      equipmentCatalog,
      capabilityCatalog,
      householdEquipment,
      options,
    });
    return {
      ...graph,
      householdId: householdId || "unknown",
    };
  }

  // -------------------------
  // Internal helpers
  // -------------------------

  static _bindApi(ctx) {
    const {
      equipmentById,
      defsById,
      aliasIndex,
      equipmentToGrants,
      capabilityToEquipment,
      opts,
    } = ctx;

    return {
      getEquipment: (equipmentId) => equipmentById[equipmentId] || null,

      getCapabilityDef: (capabilityId) => {
        const id = normalizeCapabilityId(capabilityId, aliasIndex);
        return defsById[id] || null;
      },

      getCapabilitiesForEquipment: (equipmentId) => {
        const e = equipmentById[equipmentId];
        if (!e) return [];
        return (equipmentToGrants[equipmentId] || []).map((g) => {
          const def = defsById[g.capabilityId];
          const level = clampLevel(g.level, def, opts);
          return {
            id: g.capabilityId,
            level,
            weight: Number.isFinite(g.weight) ? g.weight : opts.defaultWeight,
            label:
              opts.preferCapabilityCatalogLabels && def?.label
                ? def.label
                : g.capabilityId,
            category: def?.category,
            notes: g.notes,
          };
        });
      },

      getEquipmentForCapability: (capabilityId, { minLevel = 1 } = {}) => {
        const id = normalizeCapabilityId(capabilityId, aliasIndex);
        const list = capabilityToEquipment[id] || [];
        const min = Number.isFinite(minLevel) ? Number(minLevel) : 1;
        // Sort by level desc then weight desc for stable "best tool" selection
        return list
          .filter((x) => (Number(x.level) || 0) >= min)
          .slice()
          .sort(
            (a, b) =>
              b.level - a.level ||
              (b.weight || 0) - (a.weight || 0) ||
              (a.equipmentId > b.equipmentId ? 1 : -1)
          );
      },

      /**
       * Compute household capabilities for a given householdEquipment set.
       * @param {Object} args
       * @param {Array<string|Object>} args.householdEquipment
       * @param {boolean=} args.includeEvidence
       */
      getHouseholdCapabilities: ({
        householdEquipment,
        includeEvidence = true,
      } = {}) => {
        const householdIndex = buildHouseholdEquipmentIndex(householdEquipment);
        return KitchenCapabilityGraph._computeHouseholdCapabilities({
          equipmentById,
          defsById,
          aliasIndex,
          householdIndex,
          opts,
          includeEvidence,
        });
      },

      /**
       * Explain why a capability exists (or doesn't) for a household set.
       * @param {Object} args
       * @param {string} args.capabilityId
       * @param {Array<string|Object>} args.householdEquipment
       */
      explainCapabilityForHousehold: ({
        capabilityId,
        householdEquipment,
      } = {}) => {
        const householdIndex = buildHouseholdEquipmentIndex(householdEquipment);
        const id = normalizeCapabilityId(capabilityId, aliasIndex);
        const capDef = defsById[id] || null;

        const household = KitchenCapabilityGraph._computeHouseholdCapabilities({
          equipmentById,
          defsById,
          aliasIndex,
          householdIndex,
          opts,
          includeEvidence: true,
        });

        const entry = household.capabilities[id];
        if (entry) {
          return {
            status: "present",
            capabilityId: id,
            label: capDef?.label || id,
            level: entry.level,
            sources: entry.sources || [],
            suggestion: null,
          };
        }

        // Not present: suggest candidate equipment
        const candidates = (capabilityToEquipment[id] || [])
          .slice()
          .sort(
            (a, b) => b.level - a.level || (b.weight || 0) - (a.weight || 0)
          );

        return {
          status: "missing",
          capabilityId: id,
          label: capDef?.label || id,
          level: 0,
          sources: [],
          suggestion: candidates.slice(0, 5),
        };
      },

      /**
       * Check whether householdEquipment satisfies the provided requirements.
       * Returns { ok, missingAllOf, failedAnyOfGroup, violatedNoneOf, details }
       */
      checkRequirements: (requirements, { householdEquipment } = {}) => {
        const household = this.getHouseholdCapabilities({
          householdEquipment,
          includeEvidence: true,
        });
        return KitchenCapabilityGraph._checkRequirementsAgainstIndex(
          requirements,
          household,
          aliasIndex
        );
      },

      /**
       * Returns a rich diff between requirements and household capabilities.
       * Useful for UI panels ("what you have" vs "what you need").
       */
      diffHouseholdVsRequirements: (
        requirements,
        { householdEquipment } = {}
      ) => {
        const household = this.getHouseholdCapabilities({
          householdEquipment,
          includeEvidence: true,
        });
        return KitchenCapabilityGraph._diffHouseholdVsRequirements(
          requirements,
          household,
          aliasIndex,
          defsById
        );
      },
    };
  }

  static _computeHouseholdCapabilities({
    equipmentById,
    defsById,
    aliasIndex,
    householdIndex,
    opts,
    includeEvidence = true,
  }) {
    /** @type {CapabilityIndex} */
    const capIndex = Object.create(null);

    /** @type {{[equipmentId:string]: any[]}} */
    const evidenceByEquipment = Object.create(null);

    const enabledEquipmentIds = Object.values(householdIndex)
      .filter((e) => !!e?.enabled && (Number(e.quantity) || 0) > 0)
      .map((e) => e.id);

    for (const equipmentId of enabledEquipmentIds) {
      const eq = equipmentById[equipmentId];
      if (!eq) continue;

      const grants = eq.grants || [];
      evidenceByEquipment[equipmentId] = [];

      for (const g of grants) {
        const capId = normalizeCapabilityId(g.capabilityId, aliasIndex);
        if (!capId) continue;

        const def = defsById[capId];
        const level = clampLevel(g.level, def, opts);

        const source = {
          equipmentId,
          equipmentLabel: eq.label,
          capabilityId: capId,
          level,
          weight: Number.isFinite(g.weight) ? g.weight : opts.defaultWeight,
          notes: g.notes,
          when: g.when,
          // carry minimal raw context for debugging/audit trails
          meta: {
            equipmentType: eq.type,
            equipmentTags: eq.tags,
          },
        };

        evidenceByEquipment[equipmentId].push(source);

        const incoming = {
          level,
          sources: includeEvidence ? [source] : [],
          def: def || undefined,
        };

        capIndex[capId] = mergeCapability(capIndex[capId], incoming);
      }
    }

    // Ensure stable ordering in sources (best level first)
    for (const [capId, entry] of Object.entries(capIndex)) {
      if (!entry?.sources || !Array.isArray(entry.sources)) continue;
      entry.sources = entry.sources
        .slice()
        .sort(
          (a, b) =>
            b.level - a.level ||
            (b.weight || 0) - (a.weight || 0) ||
            (a.equipmentId > b.equipmentId ? 1 : -1)
        );
      capIndex[capId] = entry;
    }

    const stats = {
      equipmentEnabled: enabledEquipmentIds.length,
      capabilitiesCount: Object.keys(capIndex).length,
      evidenceRows: Object.values(evidenceByEquipment).reduce(
        (n, arr) => n + (arr?.length || 0),
        0
      ),
    };

    return {
      capabilities: capIndex,
      evidenceByEquipment: includeEvidence ? evidenceByEquipment : undefined,
      meta: {
        generatedAt: nowISO(),
        stats,
        options: opts,
      },
    };
  }

  static _checkRequirementsAgainstIndex(
    requirements,
    householdOut,
    aliasIndex
  ) {
    const req = normalizeRequirements(requirements);
    const capIndex = householdOut?.capabilities || Object.create(null);

    const missingAllOf = [];
    const violatedNoneOf = [];
    const anyOfAtoms = req.anyOf.map(normalizeRequirementAtom).filter(Boolean);

    // allOf
    for (const atom of req.allOf
      .map(normalizeRequirementAtom)
      .filter(Boolean)) {
      const id = normalizeCapabilityId(atom.id, aliasIndex);
      const have = capIndex[id];
      const ok =
        !!have && (Number(have.level) || 0) >= (Number(atom.minLevel) || 1);
      if (!ok)
        missingAllOf.push({
          id,
          minLevel: atom.minLevel || 1,
          haveLevel: have?.level || 0,
        });
    }

    // noneOf
    for (const atom of req.noneOf
      .map(normalizeRequirementAtom)
      .filter(Boolean)) {
      const id = normalizeCapabilityId(atom.id, aliasIndex);
      const have = capIndex[id];
      const violates =
        !!have && (Number(have.level) || 0) >= (Number(atom.minLevel) || 1);
      if (violates)
        violatedNoneOf.push({
          id,
          minLevel: atom.minLevel || 1,
          haveLevel: have?.level || 0,
        });
    }

    // anyOf: treat as one group: at least one must pass
    let anyOfSatisfied = true;
    if (anyOfAtoms.length) {
      anyOfSatisfied = anyOfAtoms.some((atom) => {
        const id = normalizeCapabilityId(atom.id, aliasIndex);
        const have = capIndex[id];
        return (
          !!have && (Number(have.level) || 0) >= (Number(atom.minLevel) || 1)
        );
      });
    }

    const ok =
      missingAllOf.length === 0 &&
      violatedNoneOf.length === 0 &&
      anyOfSatisfied;

    return {
      ok,
      missingAllOf,
      violatedNoneOf,
      failedAnyOfGroup: anyOfAtoms.length ? !anyOfSatisfied : false,
      details: {
        normalized: req,
      },
    };
  }

  static _diffHouseholdVsRequirements(
    requirements,
    householdOut,
    aliasIndex,
    defsById
  ) {
    const check = this._checkRequirementsAgainstIndex(
      requirements,
      householdOut,
      aliasIndex
    );
    const capIndex = householdOut?.capabilities || Object.create(null);
    const req = normalizeRequirements(requirements);

    const needed = []
      .concat(req.allOf)
      .concat(req.anyOf)
      .concat(req.noneOf)
      .map(normalizeRequirementAtom)
      .filter(Boolean)
      .map((atom) => {
        const id = normalizeCapabilityId(atom.id, aliasIndex);
        const def = defsById?.[id];
        const have = capIndex?.[id];
        return {
          id,
          label: def?.label || id,
          category: def?.category,
          minLevel: atom.minLevel || 1,
          haveLevel: have?.level || 0,
          status:
            req.noneOf.includes(atom.id) || req.noneOf.includes(id)
              ? have && (have.level || 0) >= (atom.minLevel || 1)
                ? "violates"
                : "ok"
              : have && (have.level || 0) >= (atom.minLevel || 1)
              ? "ok"
              : "missing",
          sources: have?.sources || [],
        };
      });

    // Present (beyond requirements)
    const presentExtra = Object.keys(capIndex)
      .filter((id) => !needed.some((n) => n.id === id))
      .map((id) => {
        const def = defsById?.[id];
        const have = capIndex[id];
        return {
          id,
          label: def?.label || id,
          category: def?.category,
          level: have?.level || 0,
          sources: have?.sources || [],
        };
      })
      .sort((a, b) => b.level - a.level || (a.id > b.id ? 1 : -1));

    return {
      ok: check.ok,
      check,
      needed,
      presentExtra,
      meta: {
        generatedAt: nowISO(),
      },
    };
  }
}

export default KitchenCapabilityGraph;
