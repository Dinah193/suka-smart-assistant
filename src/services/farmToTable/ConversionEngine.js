// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\ConversionEngine.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead ConversionEngine
 * -----------------------------------------------------------------------------
 * Browser-safe unit + yield conversion utilities used across:
 *  - ProvisioningTargetEngine (servings -> component default units)
 *  - ComponentDemandBuilder (input/output yield ratios)
 *  - Inventory readiness & shelf life views (normalize quantities)
 *  - Preservation batch planning (raw produce -> jars / dehydrated yield)
 *
 * Goals
 *  - Deterministic conversions with explainable traces.
 *  - Flexible: works with sparse catalogs and progressively improves with rules.
 *  - Safe defaults: if unknown conversion, no crash; returns "unchanged" with reason.
 *
 * -----------------------------------------------------------------------------
 * Core concepts
 * -----------------------------------------------------------------------------
 * Units:
 *  - Mass: g, kg, oz, lb
 *  - Volume: ml, l, tsp, tbsp, cup, pt, qt, gal
 *  - Count: each, unit, item, piece
 *  - Serving: serving (abstract)
 *
 * Conversions supported:
 *  1) Generic conversions within the same dimension (mass<->mass, volume<->volume)
 *  2) Component-specific conversions:
 *     - serving -> g (or ml) via component.servingSize
 *     - each -> g (or ml) via component.itemWeight / itemVolume
 *  3) Yield conversions:
 *     - raw -> preserved (e.g., produce -> jar) via yield maps
 *
 * -----------------------------------------------------------------------------
 * Public API
 * -----------------------------------------------------------------------------
 *  - createRegistry(catalogBundle?, overrides?)
 *  - convertQuantity({ qty, fromUnit, toUnit, component?, context?, registry? })
 *  - convertBatch({ lines: [{ componentId, qty, unit }], toUnit, ... })
 *  - estimateYield({ inputQty, inputUnit, outputUnit, yieldRatio?, component?, methodId?, registry? })
 *  - normalizeUnit(unit)
 *  - getUnitMeta(unit)
 *
 * Registry:
 *  {
 *    units: { [unit]: { dim, toBase, fromBase } },
 *    componentRules: { [componentId]: { servingSize?, itemWeight?, itemVolume?, density? } },
 *    yieldRules: { [key]: { ratio, inUnit, outUnit, notes } }
 *  }
 */

const SOURCE = "services/farmToTable/ConversionEngine";

/* -----------------------------------------------------------------------------
 * Units
 * --------------------------------------------------------------------------- */

const UNIT_ALIASES = {
  // count
  each: ["ea", "each", "unit", "item", "piece", "pc", "count"],
  // serving
  serving: ["serving", "srv"],
  // mass
  g: ["g", "gram", "grams"],
  kg: ["kg", "kilogram", "kilograms"],
  oz: ["oz", "ounce", "ounces"],
  lb: ["lb", "lbs", "pound", "pounds"],
  // volume
  ml: ["ml", "milliliter", "milliliters"],
  l: ["l", "liter", "liters"],
  tsp: ["tsp", "teaspoon", "teaspoons"],
  tbsp: ["tbsp", "tablespoon", "tablespoons"],
  cup: ["cup", "cups"],
  pt: ["pt", "pint", "pints"],
  qt: ["qt", "quart", "quarts"],
  gal: ["gal", "gallon", "gallons"],
};

const DIM = {
  MASS: "mass",
  VOLUME: "volume",
  COUNT: "count",
  SERVING: "serving",
  OTHER: "other",
};

const BASE_UNITS = {
  [DIM.MASS]: "g",
  [DIM.VOLUME]: "ml",
  [DIM.COUNT]: "each",
  [DIM.SERVING]: "serving",
};

const UNIT_DEFS = {
  // Count (base each)
  each: { dim: DIM.COUNT, toBase: (x) => x, fromBase: (x) => x },

  // Serving (base serving)
  serving: { dim: DIM.SERVING, toBase: (x) => x, fromBase: (x) => x },

  // Mass (base g)
  g: { dim: DIM.MASS, toBase: (x) => x, fromBase: (x) => x },
  kg: { dim: DIM.MASS, toBase: (x) => x * 1000, fromBase: (x) => x / 1000 },
  oz: {
    dim: DIM.MASS,
    toBase: (x) => x * 28.349523125,
    fromBase: (x) => x / 28.349523125,
  },
  lb: {
    dim: DIM.MASS,
    toBase: (x) => x * 453.59237,
    fromBase: (x) => x / 453.59237,
  },

  // Volume (base ml)
  ml: { dim: DIM.VOLUME, toBase: (x) => x, fromBase: (x) => x },
  l: { dim: DIM.VOLUME, toBase: (x) => x * 1000, fromBase: (x) => x / 1000 },
  tsp: {
    dim: DIM.VOLUME,
    toBase: (x) => x * 4.92892159375,
    fromBase: (x) => x / 4.92892159375,
  },
  tbsp: {
    dim: DIM.VOLUME,
    toBase: (x) => x * 14.78676478125,
    fromBase: (x) => x / 14.78676478125,
  },
  cup: {
    dim: DIM.VOLUME,
    toBase: (x) => x * 236.5882365,
    fromBase: (x) => x / 236.5882365,
  },
  pt: {
    dim: DIM.VOLUME,
    toBase: (x) => x * 473.176473,
    fromBase: (x) => x / 473.176473,
  },
  qt: {
    dim: DIM.VOLUME,
    toBase: (x) => x * 946.352946,
    fromBase: (x) => x / 946.352946,
  },
  gal: {
    dim: DIM.VOLUME,
    toBase: (x) => x * 3785.411784,
    fromBase: (x) => x / 3785.411784,
  },
};

/* -----------------------------------------------------------------------------
 * Registry
 * --------------------------------------------------------------------------- */

export function createRegistry(catalogBundle, overrides) {
  const registry = {
    units: { ...UNIT_DEFS },
    aliases: buildAliasMap(),
    componentRules: {},
    yieldRules: {},
    source: SOURCE,
    builtAtISO: new Date().toISOString(),
  };

  // Seed component rules from catalog components if present
  const components = Array.isArray(catalogBundle?.components)
    ? catalogBundle.components
    : [];
  for (const c of components) {
    if (!c) continue;
    const id = safeStr(c.id);
    if (!id) continue;

    // Common fields you might store in catalog:
    // c.defaults.unit, c.defaults.servingSize, c.defaults.itemWeight, c.defaults.itemVolume, c.defaults.density
    const defaults =
      c.defaults && typeof c.defaults === "object" ? c.defaults : {};

    const rule = {
      componentId: id,
      defaultUnit: normalizeUnit(defaults.unit || c.unit || "each"),
      // servingSize in grams or ml (depending on preferred dim)
      servingSize: normalizeServingSize(
        defaults.servingSize || defaults.serving_size
      ),
      servingUnit: normalizeUnit(
        defaults.servingUnit ||
          defaults.serving_unit ||
          guessServingUnit(defaults)
      ),
      itemWeight: toNum(defaults.itemWeight || defaults.item_weight, null), // grams
      itemVolume: toNum(defaults.itemVolume || defaults.item_volume, null), // ml
      // density in g/ml for cross mass<->volume conversions for this component
      density: toNum(defaults.density, null),
    };

    registry.componentRules[toLower(id)] = rule;

    // Yield rules: c.yields or defaults.yields
    const yields = Array.isArray(c.yields)
      ? c.yields
      : Array.isArray(defaults.yields)
      ? defaults.yields
      : [];
    for (const y of yields) {
      const yr = normalizeYieldRule(y, id);
      if (!yr) continue;
      registry.yieldRules[yr.key] = yr;
    }
  }

  // Apply overrides
  if (overrides && typeof overrides === "object") {
    if (overrides.units) {
      for (const k of Object.keys(overrides.units)) {
        registry.units[k] = overrides.units[k];
      }
    }
    if (overrides.componentRules) {
      for (const cid of Object.keys(overrides.componentRules)) {
        registry.componentRules[toLower(cid)] = {
          ...(registry.componentRules[toLower(cid)] || {}),
          ...(overrides.componentRules[cid] || {}),
        };
      }
    }
    if (overrides.yieldRules) {
      for (const key of Object.keys(overrides.yieldRules)) {
        const yr = normalizeYieldRule(overrides.yieldRules[key], null, key);
        if (yr) registry.yieldRules[yr.key] = yr;
      }
    }
  }

  return registry;
}

function buildAliasMap() {
  const map = {};
  for (const canonical of Object.keys(UNIT_ALIASES)) {
    for (const a of UNIT_ALIASES[canonical] || []) {
      map[toLower(a)] = canonical;
    }
    map[toLower(canonical)] = canonical;
  }
  return map;
}

/* -----------------------------------------------------------------------------
 * Public conversions
 * --------------------------------------------------------------------------- */

/**
 * Convert a single quantity.
 *
 * args:
 *  {
 *    qty,
 *    fromUnit,
 *    toUnit,
 *    component?: { id, name, defaults... } OR componentId string,
 *    context?: { registry, methodId, allowDensity? },
 *    registry?: registry
 *  }
 *
 * returns:
 *  { qty, unit, ok, trace: { steps[], warnings[] } }
 */
export function convertQuantity(args = {}) {
  const trace = { steps: [], warnings: [] };

  const qty = toNum(args.qty, NaN);
  if (!Number.isFinite(qty)) {
    trace.warnings.push("Invalid qty; returning unchanged.");
    return { qty: args.qty, unit: args.fromUnit, ok: false, trace };
  }

  const fromU = normalizeUnit(args.fromUnit);
  const toU = normalizeUnit(args.toUnit);

  if (!fromU || !toU) {
    trace.warnings.push("Missing fromUnit or toUnit; returning unchanged.");
    return { qty, unit: fromU || toU || "unit", ok: false, trace };
  }

  if (fromU === toU) {
    trace.steps.push(`No conversion needed (${fromU} -> ${toU}).`);
    return { qty, unit: toU, ok: true, trace };
  }

  const registry =
    args.registry || args.context?.registry || createRegistry(null, null);

  const fromMeta = getUnitMeta(fromU, registry);
  const toMeta = getUnitMeta(toU, registry);

  if (!fromMeta || !toMeta) {
    trace.warnings.push(
      `Unknown unit(s): ${fromU} or ${toU}. Returning unchanged.`
    );
    return { qty, unit: fromU, ok: false, trace };
  }

  // 1) Same dimension generic conversion
  if (fromMeta.dim === toMeta.dim && fromMeta.dim !== DIM.OTHER) {
    const base = registry.units[fromMeta.unit].toBase(qty);
    const out = registry.units[toMeta.unit].fromBase(base);
    trace.steps.push(
      `Converted ${qty} ${fromU} -> ${out} ${toU} via base ${
        BASE_UNITS[fromMeta.dim]
      }.`
    );
    return { qty: out, unit: toU, ok: true, trace };
  }

  // 2) Component-specific conversions involving serving or count
  const componentRule = resolveComponentRule(
    args.component,
    args.componentId,
    registry
  );
  if (componentRule) {
    // serving <-> mass/volume
    const servingConvert = tryServingConversions(
      qty,
      fromMeta,
      toMeta,
      componentRule,
      registry,
      trace
    );
    if (servingConvert) return servingConvert;

    // count(each) <-> mass/volume via itemWeight/itemVolume
    const countConvert = tryCountConversions(
      qty,
      fromMeta,
      toMeta,
      componentRule,
      registry,
      trace
    );
    if (countConvert) return countConvert;

    // mass <-> volume via density (component-specific)
    const densityConvert = tryDensityConversions(
      qty,
      fromMeta,
      toMeta,
      componentRule,
      registry,
      trace
    );
    if (densityConvert) return densityConvert;
  } else {
    trace.warnings.push(
      "No component rule available for cross-dimension conversion."
    );
  }

  // 3) Fallback: if one side is "unit/each" and the other is "serving", assume 1 each = 1 serving (very weak)
  if (
    (fromMeta.dim === DIM.COUNT && toMeta.dim === DIM.SERVING) ||
    (fromMeta.dim === DIM.SERVING && toMeta.dim === DIM.COUNT)
  ) {
    trace.warnings.push(
      "Fallback used: assumed 1 each == 1 serving (no component rule)."
    );
    return { qty, unit: toU, ok: true, trace };
  }

  trace.warnings.push(
    `No known conversion path for ${fromU} -> ${toU}. Returning unchanged.`
  );
  return { qty, unit: fromU, ok: false, trace };
}

/**
 * Convert multiple lines to a unified unit (or to each line's component default unit).
 *
 * args:
 *  {
 *    lines: [{ componentId?, component?, qty, unit }],
 *    toUnit?: string, // optional; if omitted, uses component default
 *    registry,
 *  }
 */
export function convertBatch(args = {}) {
  const registry = args.registry || createRegistry(null, null);
  const lines = Array.isArray(args.lines) ? args.lines : [];
  const toUnit = args.toUnit ? normalizeUnit(args.toUnit) : null;

  const converted = [];
  const issues = [];

  for (const line of lines) {
    const rule = resolveComponentRule(
      line.component,
      line.componentId,
      registry
    );
    const targetUnit =
      toUnit || normalizeUnit(rule?.defaultUnit || line.unit || "each");

    const res = convertQuantity({
      qty: line.qty,
      fromUnit: line.unit,
      toUnit: targetUnit,
      component: line.component,
      componentId: line.componentId,
      registry,
    });

    converted.push({
      ...line,
      qty: res.qty,
      unit: res.unit,
      conversionTrace: res.trace,
    });
    if (!res.ok) issues.push({ line, trace: res.trace });
  }

  return {
    lines: converted,
    issues,
    registryMeta: { builtAtISO: registry.builtAtISO },
  };
}

/**
 * Estimate yield conversion (input -> output) using:
 *  - explicit yieldRatio (preferred)
 *  - registry yieldRules keyed by componentId and methodId (optional)
 *
 * returns { outputQty, outputUnit, ok, trace }
 */
export function estimateYield(args = {}) {
  const trace = { steps: [], warnings: [] };
  const registry = args.registry || createRegistry(null, null);

  const inputQty = toNum(args.inputQty, NaN);
  if (!Number.isFinite(inputQty)) {
    trace.warnings.push("Invalid inputQty.");
    return {
      outputQty: args.inputQty,
      outputUnit: args.outputUnit,
      ok: false,
      trace,
    };
  }

  const inputUnit = normalizeUnit(args.inputUnit);
  const outputUnit = normalizeUnit(args.outputUnit);
  if (!inputUnit || !outputUnit) {
    trace.warnings.push("Missing inputUnit or outputUnit.");
    return {
      outputQty: inputQty,
      outputUnit: outputUnit || inputUnit,
      ok: false,
      trace,
    };
  }

  // If explicit ratio provided, use it
  const ratio = toNum(args.yieldRatio, null);
  if (Number.isFinite(ratio) && ratio > 0) {
    trace.steps.push(`Used explicit yieldRatio ${ratio} (output per input).`);
    const out = inputQty * ratio;
    return { outputQty: out, outputUnit, ok: true, trace };
  }

  // Try registry yield rule by key
  const componentId = safeStr(args.componentId || args.component?.id);
  const methodId = safeStr(args.methodId);
  const ruleKey = buildYieldKey(componentId, methodId, inputUnit, outputUnit);

  const yr = registry.yieldRules[ruleKey] || null;
  if (!yr) {
    trace.warnings.push(
      `No yield rule found for key "${ruleKey}". Returning unchanged.`
    );
    return { outputQty: inputQty, outputUnit: outputUnit, ok: false, trace };
  }

  // Convert input to rule's inUnit if needed
  let qtyIn = inputQty;
  if (normalizeUnit(yr.inUnit) && normalizeUnit(yr.inUnit) !== inputUnit) {
    const conv = convertQuantity({
      qty: inputQty,
      fromUnit: inputUnit,
      toUnit: yr.inUnit,
      componentId,
      component: args.component,
      registry,
    });
    qtyIn = toNum(conv.qty, inputQty);
    trace.steps.push(
      `Converted input to yield-rule unit: ${inputQty} ${inputUnit} -> ${qtyIn} ${yr.inUnit}.`
    );
  }

  const outQtyRule = qtyIn * toNum(yr.ratio, 1);
  trace.steps.push(
    `Applied yield rule ratio ${yr.ratio} => ${outQtyRule} ${yr.outUnit}.`
  );

  // Convert output to requested outputUnit if needed
  let outQty = outQtyRule;
  if (normalizeUnit(yr.outUnit) && normalizeUnit(yr.outUnit) !== outputUnit) {
    const conv2 = convertQuantity({
      qty: outQtyRule,
      fromUnit: yr.outUnit,
      toUnit: outputUnit,
      componentId,
      component: args.component,
      registry,
    });
    outQty = toNum(conv2.qty, outQtyRule);
    trace.steps.push(
      `Converted yield output unit: ${outQtyRule} ${yr.outUnit} -> ${outQty} ${outputUnit}.`
    );
  }

  return { outputQty: outQty, outputUnit, ok: true, trace };
}

/* -----------------------------------------------------------------------------
 * Unit helpers
 * --------------------------------------------------------------------------- */

export function normalizeUnit(unit, registry) {
  const u = safeStr(unit);
  if (!u) return "";
  const r = registry || null;
  const aliases = r?.aliases || buildAliasMap();
  const k = toLower(u);
  return aliases[k] || k;
}

export function getUnitMeta(unit, registry) {
  const r = registry || createRegistry(null, null);
  const u = normalizeUnit(unit, r);
  const def = r.units[u];
  if (!def) return null;
  return { unit: u, dim: def.dim };
}

/* -----------------------------------------------------------------------------
 * Internal conversion paths
 * --------------------------------------------------------------------------- */

function resolveComponentRule(component, componentId, registry) {
  const r = registry || createRegistry(null, null);
  const id = safeStr(componentId || component?.id);
  if (!id) return null;
  return r.componentRules[toLower(id)] || null;
}

function tryServingConversions(qty, fromMeta, toMeta, rule, registry, trace) {
  const r = registry;

  // serving -> mass/volume
  if (
    fromMeta.dim === DIM.SERVING &&
    (toMeta.dim === DIM.MASS || toMeta.dim === DIM.VOLUME)
  ) {
    const size = rule.servingSize;
    const sizeUnit = normalizeUnit(
      rule.servingUnit || (toMeta.dim === DIM.MASS ? "g" : "ml"),
      r
    );

    if (!Number.isFinite(size) || size <= 0) {
      trace.warnings.push(
        "No servingSize defined for component; cannot convert serving to mass/volume."
      );
      return null;
    }

    // qty servings -> sizeUnit
    const baseQty = qty * size;
    trace.steps.push(
      `Serving conversion: ${qty} serving * ${size} ${sizeUnit}/serving = ${baseQty} ${sizeUnit}.`
    );

    // If sizeUnit matches target dimension unit path, convert generic
    const conv = convertQuantity({
      qty: baseQty,
      fromUnit: sizeUnit,
      toUnit: toMeta.unit,
      componentId: rule.componentId,
      registry: r,
    });
    if (conv.ok)
      return {
        qty: conv.qty,
        unit: toMeta.unit,
        ok: true,
        trace: mergeTrace(trace, conv.trace),
      };

    // If toMeta.unit differs only in unit within same dimension, the above handles it
    trace.warnings.push("Failed to convert serving-size unit to target unit.");
    return null;
  }

  // mass/volume -> serving
  if (
    (fromMeta.dim === DIM.MASS || fromMeta.dim === DIM.VOLUME) &&
    toMeta.dim === DIM.SERVING
  ) {
    const size = rule.servingSize;
    const sizeUnit = normalizeUnit(
      rule.servingUnit || (fromMeta.dim === DIM.MASS ? "g" : "ml"),
      r
    );

    if (!Number.isFinite(size) || size <= 0) {
      trace.warnings.push(
        "No servingSize defined for component; cannot convert mass/volume to serving."
      );
      return null;
    }

    // Convert input qty into sizeUnit
    const convIn = convertQuantity({
      qty,
      fromUnit: fromMeta.unit,
      toUnit: sizeUnit,
      componentId: rule.componentId,
      registry: r,
    });
    const qtyIn = convIn.ok ? convIn.qty : qty;

    if (convIn.ok)
      trace.steps.push(
        `Converted input to servingSize unit: ${qty} ${fromMeta.unit} -> ${qtyIn} ${sizeUnit}.`
      );
    const servings = qtyIn / size;

    trace.steps.push(
      `Serving conversion: ${qtyIn} ${sizeUnit} / ${size} ${sizeUnit}/serving = ${servings} serving.`
    );
    return {
      qty: servings,
      unit: "serving",
      ok: true,
      trace: mergeTrace(trace, convIn.trace),
    };
  }

  return null;
}

function tryCountConversions(qty, fromMeta, toMeta, rule, registry, trace) {
  const r = registry;

  // each -> mass/volume
  if (
    fromMeta.dim === DIM.COUNT &&
    (toMeta.dim === DIM.MASS || toMeta.dim === DIM.VOLUME)
  ) {
    const itemWeight = Number.isFinite(rule.itemWeight)
      ? rule.itemWeight
      : null; // grams
    const itemVolume = Number.isFinite(rule.itemVolume)
      ? rule.itemVolume
      : null; // ml

    if (toMeta.dim === DIM.MASS && itemWeight && itemWeight > 0) {
      const baseQty = qty * itemWeight;
      trace.steps.push(
        `Count conversion: ${qty} each * ${itemWeight} g/each = ${baseQty} g.`
      );
      const conv = convertQuantity({
        qty: baseQty,
        fromUnit: "g",
        toUnit: toMeta.unit,
        componentId: rule.componentId,
        registry: r,
      });
      return {
        qty: conv.qty,
        unit: toMeta.unit,
        ok: conv.ok,
        trace: mergeTrace(trace, conv.trace),
      };
    }

    if (toMeta.dim === DIM.VOLUME && itemVolume && itemVolume > 0) {
      const baseQty = qty * itemVolume;
      trace.steps.push(
        `Count conversion: ${qty} each * ${itemVolume} ml/each = ${baseQty} ml.`
      );
      const conv = convertQuantity({
        qty: baseQty,
        fromUnit: "ml",
        toUnit: toMeta.unit,
        componentId: rule.componentId,
        registry: r,
      });
      return {
        qty: conv.qty,
        unit: toMeta.unit,
        ok: conv.ok,
        trace: mergeTrace(trace, conv.trace),
      };
    }

    trace.warnings.push(
      "No itemWeight/itemVolume defined for component; cannot convert count to mass/volume."
    );
    return null;
  }

  // mass/volume -> each
  if (
    (fromMeta.dim === DIM.MASS || fromMeta.dim === DIM.VOLUME) &&
    toMeta.dim === DIM.COUNT
  ) {
    const itemWeight = Number.isFinite(rule.itemWeight)
      ? rule.itemWeight
      : null;
    const itemVolume = Number.isFinite(rule.itemVolume)
      ? rule.itemVolume
      : null;

    if (fromMeta.dim === DIM.MASS && itemWeight && itemWeight > 0) {
      const convIn = convertQuantity({
        qty,
        fromUnit: fromMeta.unit,
        toUnit: "g",
        componentId: rule.componentId,
        registry,
      });
      const g = convIn.ok ? convIn.qty : qty;
      const each = g / itemWeight;
      trace.steps.push(
        `Count conversion: ${g} g / ${itemWeight} g/each = ${each} each.`
      );
      return {
        qty: each,
        unit: "each",
        ok: true,
        trace: mergeTrace(trace, convIn.trace),
      };
    }

    if (fromMeta.dim === DIM.VOLUME && itemVolume && itemVolume > 0) {
      const convIn = convertQuantity({
        qty,
        fromUnit: fromMeta.unit,
        toUnit: "ml",
        componentId: rule.componentId,
        registry,
      });
      const ml = convIn.ok ? convIn.qty : qty;
      const each = ml / itemVolume;
      trace.steps.push(
        `Count conversion: ${ml} ml / ${itemVolume} ml/each = ${each} each.`
      );
      return {
        qty: each,
        unit: "each",
        ok: true,
        trace: mergeTrace(trace, convIn.trace),
      };
    }

    trace.warnings.push(
      "No itemWeight/itemVolume defined for component; cannot convert mass/volume to count."
    );
    return null;
  }

  return null;
}

function tryDensityConversions(qty, fromMeta, toMeta, rule, registry, trace) {
  // mass <-> volume requires density g/ml
  if (!Number.isFinite(rule.density) || rule.density <= 0) return null;

  const density = rule.density;
  const r = registry;

  if (fromMeta.dim === DIM.MASS && toMeta.dim === DIM.VOLUME) {
    // Convert from to grams
    const convG = convertQuantity({
      qty,
      fromUnit: fromMeta.unit,
      toUnit: "g",
      componentId: rule.componentId,
      registry: r,
    });
    const g = convG.ok ? convG.qty : qty;
    const ml = g / density;
    trace.steps.push(
      `Density conversion: ${g} g / ${density} g/ml = ${ml} ml.`
    );
    const convOut = convertQuantity({
      qty: ml,
      fromUnit: "ml",
      toUnit: toMeta.unit,
      componentId: rule.componentId,
      registry: r,
    });
    return {
      qty: convOut.qty,
      unit: toMeta.unit,
      ok: convOut.ok,
      trace: mergeTrace(trace, mergeTrace(convG.trace, convOut.trace)),
    };
  }

  if (fromMeta.dim === DIM.VOLUME && toMeta.dim === DIM.MASS) {
    const convML = convertQuantity({
      qty,
      fromUnit: fromMeta.unit,
      toUnit: "ml",
      componentId: rule.componentId,
      registry: r,
    });
    const ml = convML.ok ? convML.qty : qty;
    const g = ml * density;
    trace.steps.push(
      `Density conversion: ${ml} ml * ${density} g/ml = ${g} g.`
    );
    const convOut = convertQuantity({
      qty: g,
      fromUnit: "g",
      toUnit: toMeta.unit,
      componentId: rule.componentId,
      registry: r,
    });
    return {
      qty: convOut.qty,
      unit: toMeta.unit,
      ok: convOut.ok,
      trace: mergeTrace(trace, mergeTrace(convML.trace, convOut.trace)),
    };
  }

  return null;
}

/* -----------------------------------------------------------------------------
 * Yield rules
 * --------------------------------------------------------------------------- */

function normalizeYieldRule(raw, componentId, explicitKey) {
  if (!raw || typeof raw !== "object") return null;

  const cid = safeStr(raw.componentId || componentId);
  const methodId = safeStr(raw.methodId || raw.method || "");
  const inUnit = normalizeUnit(
    raw.inUnit || raw.inputUnit || raw.fromUnit || ""
  );
  const outUnit = normalizeUnit(
    raw.outUnit || raw.outputUnit || raw.toUnit || ""
  );

  const ratio = toNum(raw.ratio, NaN);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;

  const key = explicitKey || buildYieldKey(cid, methodId, inUnit, outUnit);
  if (!key) return null;

  return {
    key,
    componentId: cid,
    methodId: methodId || null,
    inUnit: inUnit || null,
    outUnit: outUnit || null,
    ratio,
    notes: safeStr(raw.notes || raw.description || ""),
  };
}

function buildYieldKey(componentId, methodId, inUnit, outUnit) {
  const cid = toLower(safeStr(componentId || ""));
  if (!cid) return "";
  const mid = toLower(safeStr(methodId || "any"));
  const iu = toLower(safeStr(inUnit || "any"));
  const ou = toLower(safeStr(outUnit || "any"));
  return `${cid}|${mid}|${iu}|${ou}`;
}

/* -----------------------------------------------------------------------------
 * Misc helpers
 * --------------------------------------------------------------------------- */

function normalizeServingSize(v) {
  const n = toNum(v, null);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function guessServingUnit(defaults) {
  // If density exists, assume grams by default
  if (defaults && (defaults.servingUnit || defaults.serving_unit))
    return defaults.servingUnit || defaults.serving_unit;
  if (defaults && Number.isFinite(Number(defaults.density))) return "g";
  // unknown -> grams as a safe standard
  return "g";
}

function mergeTrace(a, b) {
  if (!a && !b) return { steps: [], warnings: [] };
  if (!a) return b;
  if (!b) return a;

  const steps = []
    .concat(Array.isArray(a.steps) ? a.steps : [])
    .concat(Array.isArray(b.steps) ? b.steps : []);
  const warnings = []
    .concat(Array.isArray(a.warnings) ? a.warnings : [])
    .concat(Array.isArray(b.warnings) ? b.warnings : []);
  return { steps, warnings };
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* -----------------------------------------------------------------------------
 * Compatibility export
 * ---------------------------------------------------------------------------
 * Your homesteadPlanner imports: `import { ConversionEngine } from ...`
 * This named export provides that object while keeping all existing functions.
 */
export const ConversionEngine = {
  SOURCE,
  createRegistry,
  convertQuantity,
  convertBatch,
  estimateYield,
  normalizeUnit,
  getUnitMeta,
};
