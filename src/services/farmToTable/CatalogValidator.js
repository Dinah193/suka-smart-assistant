// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\CatalogValidator.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead CatalogValidator
 * -----------------------------------------------------------------------------
 * Validates catalog bundles for Homestead/Farm-to-Table planning.
 *
 * This is intentionally "strict but friendly":
 *  - Produces a detailed report (errors + warnings + fixes applied)
 *  - Can optionally auto-fix minor issues (trim strings, dedupe tags, fill lowers)
 *  - Detects broken references (methods/components), duplicate IDs, invalid shelf life
 *  - Normalized shape is expected (see CatalogLoader.js docs)
 *
 * Public API
 *  - validateBundle(bundle, options)
 *  - assertValid(bundle, options) throws if errors
 *  - summarizeReport(report) convenience for UI
 *
 * Report shape:
 *  {
 *    ok: boolean,
 *    errors: ValidationIssue[],
 *    warnings: ValidationIssue[],
 *    fixes: ValidationFix[],
 *    stats: { components, methods, tags, categories },
 *    fingerprint: { hasMeta, hasComponents, hasMethods, hasTags, hasCategories }
 *  }
 *
 * Issue shape:
 *  { code, message, path, severity, itemId?, itemType?, context? }
 *
 * Fix shape:
 *  { code, message, path, itemId?, itemType?, before?, after? }
 */

const SOURCE = "services/farmToTable/CatalogValidator";

const DEFAULTS = {
  // Auto-fix safe issues (trimming, deduping, lower fields, coercions)
  autofix: true,
  // Treat warnings as errors
  strict: false,
  // Max issues to include (avoid giant logs)
  maxIssues: 500,
  // Known shelf-life ranges (days) to detect typos
  shelfLife: {
    maxDays: 36500, // 100 years (very high but prevents absurd values)
    warnOverDays: 3650, // >10y suspicious for food items
  },
  // Require certain minimum fields?
  require: {
    component: { id: true, name: true, category: true },
    method: { id: true, name: true, category: true },
  },
};

export const CatalogValidator = {
  validateBundle,
  assertValid,
  summarizeReport,
};

/**
 * Validate a normalized catalog bundle.
 * Optionally modifies bundle in place if autofix true.
 */
export function validateBundle(bundle, options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...options,
    require: deepMerge(DEFAULTS.require, options.require || {}),
    shelfLife: { ...DEFAULTS.shelfLife, ...(options.shelfLife || {}) },
  };

  const report = {
    ok: true,
    errors: [],
    warnings: [],
    fixes: [],
    stats: {
      components: 0,
      methods: 0,
      tags: 0,
      categories: 0,
    },
    fingerprint: {
      hasMeta: !!bundle?.meta,
      hasComponents: Array.isArray(bundle?.components),
      hasMethods: Array.isArray(bundle?.methods),
      hasTags: Array.isArray(bundle?.tags),
      hasCategories: Array.isArray(bundle?.categories),
    },
  };

  // Basic shape checks
  if (!bundle || typeof bundle !== "object") {
    pushIssue(
      report,
      "E_BUNDLE_NOT_OBJECT",
      "Bundle must be an object.",
      "bundle",
      "error"
    );
    finalize(report, cfg);
    return report;
  }

  if (!bundle.meta || typeof bundle.meta !== "object") {
    pushIssue(
      report,
      "E_META_MISSING",
      "Bundle.meta missing or invalid.",
      "bundle.meta",
      "error"
    );
  } else {
    validateMeta(bundle.meta, report, cfg);
  }

  // Ensure arrays exist (autofix)
  if (!Array.isArray(bundle.components)) {
    if (cfg.autofix) {
      fix(
        report,
        "F_COMPONENTS_INIT",
        "Initialized components array.",
        "bundle.components",
        null,
        null,
        []
      );
      bundle.components = [];
    } else {
      pushIssue(
        report,
        "E_COMPONENTS_NOT_ARRAY",
        "Bundle.components must be an array.",
        "bundle.components",
        "error"
      );
    }
  }

  if (!Array.isArray(bundle.methods)) {
    if (cfg.autofix) {
      fix(
        report,
        "F_METHODS_INIT",
        "Initialized methods array.",
        "bundle.methods",
        null,
        null,
        []
      );
      bundle.methods = [];
    } else {
      pushIssue(
        report,
        "E_METHODS_NOT_ARRAY",
        "Bundle.methods must be an array.",
        "bundle.methods",
        "error"
      );
    }
  }

  if (!Array.isArray(bundle.tags)) {
    if (cfg.autofix) {
      fix(
        report,
        "F_TAGS_INIT",
        "Initialized tags array.",
        "bundle.tags",
        null,
        null,
        []
      );
      bundle.tags = [];
    } else {
      pushIssue(
        report,
        "W_TAGS_NOT_ARRAY",
        "Bundle.tags should be an array.",
        "bundle.tags",
        "warn"
      );
    }
  }

  if (!Array.isArray(bundle.categories)) {
    if (cfg.autofix) {
      fix(
        report,
        "F_CATEGORIES_INIT",
        "Initialized categories array.",
        "bundle.categories",
        null,
        null,
        []
      );
      bundle.categories = [];
    } else {
      pushIssue(
        report,
        "W_CATEGORIES_NOT_ARRAY",
        "Bundle.categories should be an array.",
        "bundle.categories",
        "warn"
      );
    }
  }

  // Validate items
  const methods = bundle.methods || [];
  const components = bundle.components || [];

  report.stats.methods = methods.length;
  report.stats.components = components.length;

  // Index methods and components by lower-id
  const methodIdSeen = new Map();
  const compIdSeen = new Map();

  for (let i = 0; i < methods.length; i++) {
    validateMethod(methods[i], i, report, cfg, methodIdSeen, bundle);
    if (report.errors.length + report.warnings.length >= cfg.maxIssues) break;
  }

  for (let i = 0; i < components.length; i++) {
    validateComponent(components[i], i, report, cfg, compIdSeen, bundle);
    if (report.errors.length + report.warnings.length >= cfg.maxIssues) break;
  }

  // Reference validation (component->methods, component inputs/outputs)
  const methodIds = new Set(methods.map((m) => toLower(m?.id)).filter(Boolean));
  const compIds = new Set(
    components.map((c) => toLower(c?.id)).filter(Boolean)
  );

  for (const c of components) {
    if (!c) continue;

    // preservationMethods must reference known method ids (warning)
    const pms = Array.isArray(c.preservationMethods)
      ? c.preservationMethods
      : [];
    for (const mid of pms) {
      const key = toLower(mid);
      if (!key) continue;
      if (!methodIds.has(key)) {
        pushIssue(
          report,
          "W_UNKNOWN_METHOD_REF",
          `Component references unknown preservation method: "${mid}".`,
          `components[id=${c.id}].preservationMethods`,
          "warn",
          c.id,
          "component",
          { methodId: mid }
        );
      }
    }

    // inputs/outputs should reference known component ids (warning)
    for (const inputId of normalizeStringArray(c.inputs)) {
      const key = toLower(inputId);
      if (!compIds.has(key)) {
        pushIssue(
          report,
          "W_UNKNOWN_COMPONENT_INPUT",
          `Component input references unknown component id: "${inputId}".`,
          `components[id=${c.id}].inputs`,
          "warn",
          c.id,
          "component",
          { inputId }
        );
      }
    }
    for (const outId of normalizeStringArray(c.outputs)) {
      const key = toLower(outId);
      if (!compIds.has(key)) {
        pushIssue(
          report,
          "W_UNKNOWN_COMPONENT_OUTPUT",
          `Component output references unknown component id: "${outId}".`,
          `components[id=${c.id}].outputs`,
          "warn",
          c.id,
          "component",
          { outputId: outId }
        );
      }
    }
  }

  // Global tags/categories normalization
  validateAndFixTagCategoryIndexes(bundle, report, cfg);

  // Update stats after potential fixes
  report.stats.tags = Array.isArray(bundle.tags) ? bundle.tags.length : 0;
  report.stats.categories = Array.isArray(bundle.categories)
    ? bundle.categories.length
    : 0;

  finalize(report, cfg);
  return report;
}

/**
 * Throw if invalid (errors, or warnings when strict).
 */
export function assertValid(bundle, options = {}) {
  const report = validateBundle(bundle, options);
  if (!report.ok) {
    const msg = summarizeReport(report);
    const err = new Error(msg);
    err.report = report;
    throw err;
  }
  return true;
}

/**
 * Summarize a validation report in a UI-friendly string.
 */
export function summarizeReport(report) {
  if (!report) return "Catalog validation: no report.";
  const e = report.errors?.length || 0;
  const w = report.warnings?.length || 0;
  const f = report.fixes?.length || 0;
  const s = report.stats || {};
  const ok = report.ok ? "OK" : "FAILED";

  return [
    `Catalog validation ${ok}.`,
    `components=${s.components || 0}, methods=${s.methods || 0}, tags=${
      s.tags || 0
    }, categories=${s.categories || 0}.`,
    `errors=${e}, warnings=${w}, fixes=${f}.`,
    e
      ? `First error: ${report.errors[0]?.code} — ${report.errors[0]?.message}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/* -----------------------------------------------------------------------------
 * Meta validation
 * --------------------------------------------------------------------------- */

function validateMeta(meta, report, cfg) {
  const path = "bundle.meta";

  if (!isNonEmptyString(meta.id)) {
    if (cfg.autofix) {
      const before = meta.id;
      meta.id = "ssa.homestead.catalog";
      fix(
        report,
        "F_META_ID_DEFAULT",
        "Set missing meta.id to default.",
        `${path}.id`,
        null,
        "meta",
        before,
        meta.id
      );
    } else {
      pushIssue(
        report,
        "E_META_ID_MISSING",
        "meta.id is required.",
        `${path}.id`,
        "error"
      );
    }
  }

  if (!isNonEmptyString(meta.title)) {
    if (cfg.autofix) {
      const before = meta.title;
      meta.title = "Homestead Catalog";
      fix(
        report,
        "F_META_TITLE_DEFAULT",
        "Set missing meta.title to default.",
        `${path}.title`,
        null,
        "meta",
        before,
        meta.title
      );
    } else {
      pushIssue(
        report,
        "W_META_TITLE_MISSING",
        "meta.title should be present.",
        `${path}.title`,
        "warn"
      );
    }
  }

  if (!isNonEmptyString(meta.version)) {
    if (cfg.autofix) {
      const before = meta.version;
      meta.version = "1.0.0";
      fix(
        report,
        "F_META_VERSION_DEFAULT",
        "Set missing meta.version to default.",
        `${path}.version`,
        null,
        "meta",
        before,
        meta.version
      );
    } else {
      pushIssue(
        report,
        "W_META_VERSION_MISSING",
        "meta.version should be present.",
        `${path}.version`,
        "warn"
      );
    }
  }

  if (meta.counts && typeof meta.counts !== "object") {
    pushIssue(
      report,
      "W_META_COUNTS_INVALID",
      "meta.counts should be an object.",
      `${path}.counts`,
      "warn"
    );
  }
}

/* -----------------------------------------------------------------------------
 * Item validation
 * --------------------------------------------------------------------------- */

function validateMethod(method, index, report, cfg, seen, bundle) {
  const path = `methods[${index}]`;
  if (!method || typeof method !== "object") {
    pushIssue(
      report,
      "E_METHOD_NOT_OBJECT",
      "Method must be an object.",
      path,
      "error"
    );
    return;
  }

  if (cfg.autofix) {
    // Normalize string fields
    method.id = safeTrim(method.id);
    method.name = safeTrim(method.name);
    method.category = safeTrim(method.category);
    method.description = safeTrim(method.description);

    // Fill lowers
    if (!isNonEmptyString(method.nameLower) && isNonEmptyString(method.name)) {
      fix(
        report,
        "F_METHOD_NAMELOWER",
        "Filled method.nameLower.",
        `${path}.nameLower`,
        method.id,
        "method",
        method.nameLower,
        toLower(method.name)
      );
      method.nameLower = toLower(method.name);
    }
    if (
      !isNonEmptyString(method.categoryLower) &&
      isNonEmptyString(method.category)
    ) {
      fix(
        report,
        "F_METHOD_CATEGORYLOWER",
        "Filled method.categoryLower.",
        `${path}.categoryLower`,
        method.id,
        "method",
        method.categoryLower,
        toLower(method.category)
      );
      method.categoryLower = toLower(method.category);
    }

    // Tags dedupe + trim
    if (!Array.isArray(method.tags)) method.tags = [];
    const beforeTags = method.tags;
    const tags = uniq(beforeTags.map(safeTrim).filter(Boolean));
    if (!shallowEqualArray(beforeTags, tags)) {
      fix(
        report,
        "F_METHOD_TAGS_NORMALIZE",
        "Normalized method.tags (trim/dedupe).",
        `${path}.tags`,
        method.id,
        "method",
        beforeTags,
        tags
      );
      method.tags = tags;
    }
  }

  // Required fields
  if (cfg.require.method.id && !isNonEmptyString(method.id)) {
    pushIssue(
      report,
      "E_METHOD_ID_MISSING",
      "Method.id is required.",
      `${path}.id`,
      "error",
      null,
      "method"
    );
  }
  if (cfg.require.method.name && !isNonEmptyString(method.name)) {
    pushIssue(
      report,
      "E_METHOD_NAME_MISSING",
      "Method.name is required.",
      `${path}.name`,
      "error",
      method.id,
      "method"
    );
  }
  if (cfg.require.method.category && !isNonEmptyString(method.category)) {
    pushIssue(
      report,
      "E_METHOD_CATEGORY_MISSING",
      "Method.category is required.",
      `${path}.category`,
      "error",
      method.id,
      "method"
    );
  }

  // Duplicate IDs
  const key = toLower(method.id);
  if (key) {
    if (seen.has(key)) {
      pushIssue(
        report,
        "E_DUP_METHOD_ID",
        `Duplicate method id "${method.id}".`,
        `${path}.id`,
        "error",
        method.id,
        "method",
        { firstIndex: seen.get(key) }
      );
    } else {
      seen.set(key, index);
    }
  }

  // Shelf life validation
  if (method.typicalShelfLife)
    validateShelfLife(
      method.typicalShelfLife,
      `${path}.typicalShelfLife`,
      report,
      cfg,
      method.id,
      "method"
    );

  // Safety validation
  if (method.safety && typeof method.safety !== "object") {
    pushIssue(
      report,
      "W_METHOD_SAFETY_INVALID",
      "Method.safety should be an object.",
      `${path}.safety`,
      "warn",
      method.id,
      "method"
    );
  }
}

function validateComponent(component, index, report, cfg, seen, bundle) {
  const path = `components[${index}]`;
  if (!component || typeof component !== "object") {
    pushIssue(
      report,
      "E_COMPONENT_NOT_OBJECT",
      "Component must be an object.",
      path,
      "error"
    );
    return;
  }

  if (cfg.autofix) {
    component.id = safeTrim(component.id);
    component.name = safeTrim(component.name);
    component.category = safeTrim(component.category);
    component.description = safeTrim(component.description);

    // Fill lowers
    if (
      !isNonEmptyString(component.nameLower) &&
      isNonEmptyString(component.name)
    ) {
      fix(
        report,
        "F_COMPONENT_NAMELOWER",
        "Filled component.nameLower.",
        `${path}.nameLower`,
        component.id,
        "component",
        component.nameLower,
        toLower(component.name)
      );
      component.nameLower = toLower(component.name);
    }
    if (
      !isNonEmptyString(component.categoryLower) &&
      isNonEmptyString(component.category)
    ) {
      fix(
        report,
        "F_COMPONENT_CATEGORYLOWER",
        "Filled component.categoryLower.",
        `${path}.categoryLower`,
        component.id,
        "component",
        component.categoryLower,
        toLower(component.category)
      );
      component.categoryLower = toLower(component.category);
    }

    // Tags normalize
    if (!Array.isArray(component.tags)) component.tags = [];
    const beforeTags = component.tags;
    const tags = uniq(beforeTags.map(safeTrim).filter(Boolean));
    if (!shallowEqualArray(beforeTags, tags)) {
      fix(
        report,
        "F_COMPONENT_TAGS_NORMALIZE",
        "Normalized component.tags (trim/dedupe).",
        `${path}.tags`,
        component.id,
        "component",
        beforeTags,
        tags
      );
      component.tags = tags;
    }

    // Arrays
    if (!Array.isArray(component.preservationMethods))
      component.preservationMethods = [];
    if (!Array.isArray(component.inputs)) component.inputs = [];
    if (!Array.isArray(component.outputs)) component.outputs = [];

    // Coerce inputs/outputs to string ids
    component.inputs = normalizeStringArray(component.inputs);
    component.outputs = normalizeStringArray(component.outputs);
    component.preservationMethods = normalizeStringArray(
      component.preservationMethods
    );

    // Links normalize
    if (component.links && !Array.isArray(component.links)) {
      const before = component.links;
      component.links = normalizeLinks(component.links);
      fix(
        report,
        "F_COMPONENT_LINKS_NORMALIZE",
        "Normalized component.links to array.",
        `${path}.links`,
        component.id,
        "component",
        before,
        component.links
      );
    } else if (Array.isArray(component.links)) {
      component.links = normalizeLinks(component.links);
    }
  }

  // Required fields
  if (cfg.require.component.id && !isNonEmptyString(component.id)) {
    pushIssue(
      report,
      "E_COMPONENT_ID_MISSING",
      "Component.id is required.",
      `${path}.id`,
      "error",
      null,
      "component"
    );
  }
  if (cfg.require.component.name && !isNonEmptyString(component.name)) {
    pushIssue(
      report,
      "E_COMPONENT_NAME_MISSING",
      "Component.name is required.",
      `${path}.name`,
      "error",
      component.id,
      "component"
    );
  }
  if (cfg.require.component.category && !isNonEmptyString(component.category)) {
    pushIssue(
      report,
      "E_COMPONENT_CATEGORY_MISSING",
      "Component.category is required.",
      `${path}.category`,
      "error",
      component.id,
      "component"
    );
  }

  // Duplicate IDs
  const key = toLower(component.id);
  if (key) {
    if (seen.has(key)) {
      pushIssue(
        report,
        "E_DUP_COMPONENT_ID",
        `Duplicate component id "${component.id}".`,
        `${path}.id`,
        "error",
        component.id,
        "component",
        { firstIndex: seen.get(key) }
      );
    } else {
      seen.set(key, index);
    }
  }

  // Shelf life validation
  if (component.shelfLife)
    validateShelfLife(
      component.shelfLife,
      `${path}.shelfLife`,
      report,
      cfg,
      component.id,
      "component"
    );

  // Defaults validation
  if (component.defaults && typeof component.defaults !== "object") {
    pushIssue(
      report,
      "W_COMPONENT_DEFAULTS_INVALID",
      "Component.defaults should be an object.",
      `${path}.defaults`,
      "warn",
      component.id,
      "component"
    );
  } else if (component.defaults) {
    if (
      component.defaults.unit &&
      typeof component.defaults.unit !== "string"
    ) {
      pushIssue(
        report,
        "W_COMPONENT_DEFAULT_UNIT",
        "defaults.unit should be a string.",
        `${path}.defaults.unit`,
        "warn",
        component.id,
        "component"
      );
    }
    if (
      component.defaults.yieldRatio != null &&
      !Number.isFinite(Number(component.defaults.yieldRatio))
    ) {
      pushIssue(
        report,
        "W_COMPONENT_DEFAULT_YIELD",
        "defaults.yieldRatio should be numeric.",
        `${path}.defaults.yieldRatio`,
        "warn",
        component.id,
        "component"
      );
    }
    if (
      component.defaults.batchSize != null &&
      !Number.isFinite(Number(component.defaults.batchSize))
    ) {
      pushIssue(
        report,
        "W_COMPONENT_DEFAULT_BATCHSIZE",
        "defaults.batchSize should be numeric.",
        `${path}.defaults.batchSize`,
        "warn",
        component.id,
        "component"
      );
    }
  }
}

/* -----------------------------------------------------------------------------
 * Shelf-life checks
 * --------------------------------------------------------------------------- */

function validateShelfLife(shelfLife, path, report, cfg, itemId, itemType) {
  if (!shelfLife || typeof shelfLife !== "object") {
    pushIssue(
      report,
      "W_SHELFLIFE_NOT_OBJECT",
      "ShelfLife should be an object.",
      path,
      "warn",
      itemId,
      itemType
    );
    return;
  }

  const keys = ["pantryDays", "fridgeDays", "freezerDays"];
  for (const k of keys) {
    const v = shelfLife[k];
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      pushIssue(
        report,
        "W_SHELFLIFE_NOT_NUM",
        `${k} should be numeric.`,
        `${path}.${k}`,
        "warn",
        itemId,
        itemType,
        { value: v }
      );
      continue;
    }
    if (n < 0) {
      pushIssue(
        report,
        "W_SHELFLIFE_NEGATIVE",
        `${k} should not be negative.`,
        `${path}.${k}`,
        "warn",
        itemId,
        itemType,
        { value: n }
      );
      continue;
    }
    if (n > cfg.shelfLife.maxDays) {
      pushIssue(
        report,
        "W_SHELFLIFE_TOO_LARGE",
        `${k} value looks too large.`,
        `${path}.${k}`,
        "warn",
        itemId,
        itemType,
        { value: n }
      );
      continue;
    }
    if (n > cfg.shelfLife.warnOverDays) {
      pushIssue(
        report,
        "W_SHELFLIFE_SUSPICIOUS",
        `${k} is unusually high.`,
        `${path}.${k}`,
        "warn",
        itemId,
        itemType,
        { value: n }
      );
    }
  }

  if (shelfLife.notes != null && typeof shelfLife.notes !== "string") {
    pushIssue(
      report,
      "W_SHELFLIFE_NOTES_TYPE",
      "ShelfLife.notes should be a string.",
      `${path}.notes`,
      "warn",
      itemId,
      itemType
    );
  }
}

/* -----------------------------------------------------------------------------
 * Tag/category index checks
 * --------------------------------------------------------------------------- */

function validateAndFixTagCategoryIndexes(bundle, report, cfg) {
  // Ensure bundle.tags/categories reflect actual item data.
  const derivedTags = uniq([
    ...(bundle.components || []).flatMap((c) => normalizeStringArray(c?.tags)),
    ...(bundle.methods || []).flatMap((m) => normalizeStringArray(m?.tags)),
  ])
    .map(toLower)
    .filter(Boolean)
    .sort();

  const derivedCategories = uniq([
    ...(bundle.components || [])
      .map((c) => safeTrim(c?.category))
      .filter(Boolean),
    ...(bundle.methods || []).map((m) => safeTrim(m?.category)).filter(Boolean),
  ]).sort((a, b) => a.localeCompare(b));

  if (cfg.autofix) {
    const beforeTags = Array.isArray(bundle.tags) ? bundle.tags : [];
    const normBeforeTags = uniq(beforeTags.map(toLower).filter(Boolean)).sort();
    if (!shallowEqualArray(normBeforeTags, derivedTags)) {
      fix(
        report,
        "F_BUNDLE_TAGS_REBUILD",
        "Rebuilt bundle.tags from item tags.",
        "bundle.tags",
        null,
        "bundle",
        beforeTags,
        derivedTags
      );
      bundle.tags = derivedTags;
    }

    const beforeCats = Array.isArray(bundle.categories)
      ? bundle.categories
      : [];
    const normBeforeCats = uniq(beforeCats.map(safeTrim).filter(Boolean)).sort(
      (a, b) => a.localeCompare(b)
    );
    if (!shallowEqualArray(normBeforeCats, derivedCategories)) {
      fix(
        report,
        "F_BUNDLE_CATEGORIES_REBUILD",
        "Rebuilt bundle.categories from item categories.",
        "bundle.categories",
        null,
        "bundle",
        beforeCats,
        derivedCategories
      );
      bundle.categories = derivedCategories;
    }
  } else {
    // Without autofix: warn if mismatch
    const bt = uniq((bundle.tags || []).map(toLower).filter(Boolean)).sort();
    if (!shallowEqualArray(bt, derivedTags)) {
      pushIssue(
        report,
        "W_TAG_INDEX_MISMATCH",
        "bundle.tags does not match derived tags from items.",
        "bundle.tags",
        "warn"
      );
    }
    const bc = uniq(
      (bundle.categories || []).map(safeTrim).filter(Boolean)
    ).sort((a, b) => a.localeCompare(b));
    if (!shallowEqualArray(bc, derivedCategories)) {
      pushIssue(
        report,
        "W_CATEGORY_INDEX_MISMATCH",
        "bundle.categories does not match derived categories from items.",
        "bundle.categories",
        "warn"
      );
    }
  }
}

/* -----------------------------------------------------------------------------
 * Reporting helpers
 * --------------------------------------------------------------------------- */

function pushIssue(
  report,
  code,
  message,
  path,
  severity,
  itemId,
  itemType,
  context
) {
  const issue = {
    code,
    message,
    path,
    severity: severity === "warn" ? "warning" : "error",
    itemId: itemId || null,
    itemType: itemType || null,
    context: context || null,
  };

  if (issue.severity === "error") report.errors.push(issue);
  else report.warnings.push(issue);
}

function fix(report, code, message, path, itemId, itemType, before, after) {
  report.fixes.push({
    code,
    message,
    path,
    itemId: itemId || null,
    itemType: itemType || null,
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
  });
}

function finalize(report, cfg) {
  // strict => warnings become errors
  if (cfg.strict && report.warnings.length) {
    for (const w of report.warnings) {
      report.errors.push({
        ...w,
        severity: "error",
        code: w.code.replace(/^W_/, "E_"),
      });
    }
    report.warnings = [];
  }

  // Max issues
  if (report.errors.length + report.warnings.length > cfg.maxIssues) {
    report.errors = report.errors.slice(0, cfg.maxIssues);
    report.warnings = report.warnings.slice(0, cfg.maxIssues);
    pushIssue(
      report,
      "W_ISSUE_LIMIT",
      `Issue limit reached (${cfg.maxIssues}).`,
      "report",
      "warn"
    );
  }

  report.ok = report.errors.length === 0;
}

/* -----------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------- */

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function safeTrim(s) {
  return typeof s === "string" ? s.trim() : s == null ? "" : String(s).trim();
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => safeTrim(x)).filter(Boolean);
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function shallowEqualArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // string/number shallow compare is fine
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeLinks(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((l) => {
      if (!l) return null;
      if (typeof l === "string") return { type: "link", label: l, href: l };
      const href = safeTrim(l.href || l.url);
      if (!href) return null;
      return {
        type: safeTrim(l.type || "link"),
        label: safeTrim(l.label || l.title || href),
        href,
      };
    })
    .filter(Boolean);
}

function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
      out[k] = deepMerge(out[k], b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}
