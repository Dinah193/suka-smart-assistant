// C:\Users\larho\suka-smart-assistant\src\import\ImportNormalizer.js
// Normalizes imports to internal SSA schemas
// -----------------------------------------------------------------------------
// WHERE THIS SITS
// ImportLanding.jsx → ImportService.js → ImportRouter.js → (parser) → **ImportNormalizer.js**
// → (domain engines: meals, cleaning, garden, animal, storehouse, preservation)
// → automation runtime → (optional) Hub export.
//
// PURPOSE
// - Take a parsed/imported payload from *any* supported domain
//   (recipe, cleaning, garden/seed, animal/butchery, storehouse, how-to/video, preservation)
//   and shape it into SSA’s internal, predictable, event-friendly format.
// - Attach "context intelligence" for the automation system:
//   ingredients, methods, equipment, seasonality, tags.
// - Emit events to the shared eventBus so schedulers can react.
// - If the normalized payload already contains concrete household actions
//   (sessions, inventoryChanges, storehouseChanges), attempt optional Hub export
//   when familyFundMode=true.
//
// FORWARD-THINKING
// - Uses a NORMALIZERS registry; adding a new domain is just adding a new
//   normalizer in the registry.
// - If schemaValidator exists, we validate against domain-specific schemas,
//   but we don’t hard-fail SSA if a schema is missing — we just warn.
//
// OUTPUT SHAPE (typical)
// {
//   ok: true,
//   domain: "recipe",
//   normalized: { ...domainData },
//   context: { ingredients:[], methods:[], equipment:[], seasonality:[], tags:[] },
//   sessions: [...],            // auto-generated or proposed
//   inventoryChanges: [...],    // incoming links to household inventory
//   storehouseChanges: [...],   // incoming links to storehouse goals
//   warnings: [...]
// }
//
// EVENTS EMITTED
// - import.normalized
// - import.normalized.warning
// - import.normalized.error
//
// All events: { type, ts, source, data } with ISO timestamps.
// -----------------------------------------------------------------------------

import eventBus from "../services/events/eventBus";
import config from "../config";
import * as schemaValidator from "../services/schemaValidator.js";

// -----------------------------------------------------------------------------
// Emit helper
// -----------------------------------------------------------------------------
function emitImportEvent(type, data = {}) {
  eventBus.emit(type, {
    type,
    ts: new Date().toISOString(),
    source: "import.normalizer",
    data,
  });
}

// -----------------------------------------------------------------------------
// Optional Hub export
// -----------------------------------------------------------------------------
async function exportToHubIfEnabled(payload) {
  try {
    const flags =
      (config &&
        (config.featureFlags ||
          (typeof config === "function" ? config().featureFlags : {}))) ||
      config.featureFlags ||
      {};
    const familyFundMode =
      flags.familyFundMode === true || flags.familyFundMode === "true";

    if (!familyFundMode) return;

    const { default: HubPacketFormatter } = await import(
      "@/services/hub/HubPacketFormatter.js"
    );
    const { default: FamilyFundConnector } = await import(
      "@/services/hub/FamilyFundConnector.js"
    );

    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // silent fail — SSA owns the data first
    console.warn(
      "[ImportNormalizer] Hub export failed (silent):",
      err?.message || err
    );
  }
}

// -----------------------------------------------------------------------------
// SCHEMA VALIDATION WRAPPER (defensive)
// -----------------------------------------------------------------------------
function tryValidate(schemaName, data) {
  if (!schemaValidator || typeof schemaValidator.validate !== "function") {
    return {
      ok: true,
      warnings: ["schemaValidator not available; skipping validation"],
    };
  }
  try {
    const res = schemaValidator.validate(schemaName, data);
    if (res === true || (res && res.valid)) {
      return { ok: true, warnings: [] };
    }
    return {
      ok: false,
      warnings: Array.isArray(res?.errors)
        ? res.errors.map((e) => e.message || String(e))
        : ["Schema invalid"],
    };
  } catch (err) {
    return {
      ok: false,
      warnings: ["Schema validation failed: " + (err?.message || err)],
    };
  }
}

// -----------------------------------------------------------------------------
// CONTEXT INTELLIGENCE EXTRACTION
// - very lightweight; can be replaced with a more advanced engine later
// -----------------------------------------------------------------------------
function extractContextIntelligence(domain, normalized) {
  const ctx = {
    domain,
    ingredients: [],
    methods: [],
    equipment: [],
    seasonality: [],
    tags: [],
  };

  if (!normalized || typeof normalized !== "object") return ctx;

  // Recipes: ingredients + methods + equipment
  if (domain === "recipe" && Array.isArray(normalized.ingredients)) {
    ctx.ingredients = normalized.ingredients
      .map((ing) => ing.name || ing.ingredient || ing.title)
      .filter(Boolean);

    if (Array.isArray(normalized.steps)) {
      normalized.steps.forEach((step) => {
        const s = typeof step === "string" ? step : step?.text || "";
        if (
          /bake|roast|broil|grill|sear|simmer|boil|steam|pressure cook|ferment/i.test(
            s
          )
        ) {
          ctx.methods.push(s);
        }
        if (
          /dutch oven|instant pot|air fryer|smoker|dehydrator|pressure canner|fermentation crock/i.test(
            s
          )
        ) {
          ctx.equipment.push(s);
        }
      });
    }
  }

  // Cleaning: zones + cadence
  if (domain === "cleaning") {
    if (Array.isArray(normalized.zones)) {
      ctx.tags.push("zones");
      ctx.tags.push(
        ...normalized.zones.map(
          (z) => "zone:" + (z.id || z.name || z.title || "unknown")
        )
      );
    }
    if (normalized.cadence) {
      ctx.tags.push("cadence:" + normalized.cadence);
    }
  }

  // Garden: seasonality, plant families, zones
  if (domain === "garden") {
    if (Array.isArray(normalized.plants)) {
      ctx.seasonality = normalized.plants
        .map((p) => p.season || p.plantingWindow || p.harvestWindow)
        .filter(Boolean)
        .flat();
      ctx.tags.push("plants");
    }
    if (normalized.gardenZone) {
      ctx.tags.push("garden-zone:" + normalized.gardenZone);
    }
  }

  // Animal: species, yields
  if (domain === "animal") {
    if (normalized.species) ctx.tags.push("species:" + normalized.species);
    if (normalized.yieldCurveId)
      ctx.tags.push("yieldCurve:" + normalized.yieldCurveId);
  }

  // Storehouse: categories, goals
  if (domain === "storehouse") {
    if (Array.isArray(normalized.items)) {
      ctx.tags.push("storehouse-items");
      ctx.ingredients = normalized.items
        .map((it) => it.name || it.item || it.sku)
        .filter(Boolean);
    }
  }

  // How-to / video: topics
  if (domain === "howto") {
    if (Array.isArray(normalized.steps)) {
      ctx.methods = normalized.steps
        .map((s) => (typeof s === "string" ? s : s.text))
        .filter(Boolean);
    }
    if (normalized.topic) ctx.tags.push("topic:" + normalized.topic);
  }

  // Preservation
  if (domain === "preservation") {
    ctx.tags.push("preservation");
    if (normalized.method) ctx.methods.push(normalized.method);
  }

  // dedupe
  ctx.ingredients = Array.from(new Set(ctx.ingredients));
  ctx.methods = Array.from(new Set(ctx.methods));
  ctx.equipment = Array.from(new Set(ctx.equipment));
  ctx.seasonality = Array.from(new Set(ctx.seasonality));
  ctx.tags = Array.from(new Set(ctx.tags));

  return ctx;
}

// -----------------------------------------------------------------------------
// DOMAIN NORMALIZERS
// Each one receives { parsed, raw, meta } and must return the shape noted above.
// Keep them defensive & small. Complex logic can be moved to domain engines.
// -----------------------------------------------------------------------------

function normalizeRecipe({ parsed, raw, meta }) {
  // parsed is expected to look like what RecipeParser produced
  const base = {
    title: parsed?.title || meta?.title || "Imported recipe",
    sourceUrl:
      parsed?.sourceUrl ||
      meta?.url ||
      (typeof raw === "string" && raw.startsWith("http") ? raw : undefined),
    ingredients: Array.isArray(parsed?.ingredients) ? parsed.ingredients : [],
    steps: Array.isArray(parsed?.steps) ? parsed.steps : [],
    yields: parsed?.yields || parsed?.servings || null,
    tags: parsed?.tags || [],
    cuisine: parsed?.cuisine || null,
    time: parsed?.time || parsed?.totalTime || null,
  };

  const validation = tryValidate("import.recipe", base);

  const sessions = [
    {
      type: "cooking",
      label: base.title,
      steps: base.steps,
      ingredients: base.ingredients,
    },
  ];

  const inventoryChanges = []; // linking to inventory will be done downstream
  const storehouseChanges = [];

  return {
    ok: true,
    domain: "recipe",
    normalized: base,
    context: extractContextIntelligence("recipe", base),
    sessions,
    inventoryChanges,
    storehouseChanges,
    warnings: validation.ok
      ? validation.warnings
      : ["Recipe did not fully match schema", ...validation.warnings],
  };
}

function normalizeCleaning({ parsed, raw, meta }) {
  const base = {
    title: parsed?.title || meta?.title || "Imported cleaning plan",
    zones: Array.isArray(parsed?.zones) ? parsed.zones : [],
    cadence: parsed?.cadence || "as-needed",
    routines: Array.isArray(parsed?.routines) ? parsed.routines : [],
  };

  const validation = tryValidate("import.cleaning", base);

  const sessions = [
    {
      type: "cleaning",
      label: base.title,
      zones: base.zones,
      cadence: base.cadence,
    },
  ];

  return {
    ok: true,
    domain: "cleaning",
    normalized: base,
    context: extractContextIntelligence("cleaning", base),
    sessions,
    inventoryChanges: [],
    storehouseChanges: [],
    warnings: validation.ok
      ? validation.warnings
      : ["Cleaning import not fully valid", ...validation.warnings],
  };
}

function normalizeGarden({ parsed, raw, meta }) {
  const base = {
    title: parsed?.title || meta?.title || "Imported garden plan",
    plants: Array.isArray(parsed?.plants) ? parsed.plants : [],
    gardenZone: parsed?.gardenZone || parsed?.zone || null,
    calendar: parsed?.calendar || [],
  };

  const validation = tryValidate("import.garden", base);

  const sessions = [
    {
      type: "garden",
      label: base.title,
      tasks: base.calendar,
    },
  ];

  const inventoryChanges = []; // ex: seed → inventory could be handled later
  const storehouseChanges = []; // ex: harvest → storehouse planning later

  return {
    ok: true,
    domain: "garden",
    normalized: base,
    context: extractContextIntelligence("garden", base),
    sessions,
    inventoryChanges,
    storehouseChanges,
    warnings: validation.ok
      ? validation.warnings
      : ["Garden import not fully valid", ...validation.warnings],
  };
}

function normalizeAnimal({ parsed, raw, meta }) {
  const base = {
    title: parsed?.title || meta?.title || "Imported animal/butchery plan",
    species: parsed?.species || parsed?.animal || null,
    tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
    yieldCurveId: parsed?.yieldCurveId || parsed?.yieldCurve || null,
  };

  const validation = tryValidate("import.animal", base);

  const sessions = [
    {
      type: "animal",
      label: base.title,
      tasks: base.tasks,
    },
  ];

  // animal/butchery can directly produce inventory changes (meat → storehouse)
  const inventoryChanges = Array.isArray(parsed?.inventoryChanges)
    ? parsed.inventoryChanges
    : [];
  const storehouseChanges = Array.isArray(parsed?.storehouseChanges)
    ? parsed.storehouseChanges
    : [];

  return {
    ok: true,
    domain: "animal",
    normalized: base,
    context: extractContextIntelligence("animal", base),
    sessions,
    inventoryChanges,
    storehouseChanges,
    warnings: validation.ok
      ? validation.warnings
      : ["Animal import not fully valid", ...validation.warnings],
  };
}

function normalizeStorehouse({ parsed, raw, meta }) {
  const base = {
    title: parsed?.title || meta?.title || "Imported storehouse goals",
    items: Array.isArray(parsed?.items) ? parsed.items : [],
    notes: parsed?.notes || "",
  };

  const validation = tryValidate("import.storehouse", base);

  // storehouse imports *are* data changes
  const storehouseChanges = base.items.map((it) => ({
    action: "goal.upsert",
    item: it.name || it.item || it.sku,
    targetQty: it.targetQty || it.qty || 0,
    unit: it.unit || "ea",
  }));

  return {
    ok: true,
    domain: "storehouse",
    normalized: base,
    context: extractContextIntelligence("storehouse", base),
    sessions: [],
    inventoryChanges: [],
    storehouseChanges,
    warnings: validation.ok
      ? validation.warnings
      : ["Storehouse import not fully valid", ...validation.warnings],
  };
}

function normalizeHowTo({ parsed, raw, meta }) {
  const base = {
    title: parsed?.title || meta?.title || "Imported how-to",
    steps: Array.isArray(parsed?.steps) ? parsed.steps : [],
    topic: parsed?.topic || parsed?.category || null,
    sourceUrl: parsed?.sourceUrl || meta?.url || null,
  };

  const validation = tryValidate("import.howto", base);

  const sessions = [
    {
      type: "howto",
      label: base.title,
      steps: base.steps,
    },
  ];

  return {
    ok: true,
    domain: "howto",
    normalized: base,
    context: extractContextIntelligence("howto", base),
    sessions,
    inventoryChanges: [],
    storehouseChanges: [],
    warnings: validation.ok
      ? validation.warnings
      : ["How-to import not fully valid", ...validation.warnings],
  };
}

function normalizePreservation({ parsed, raw, meta }) {
  const base = {
    title: parsed?.title || meta?.title || "Imported preservation job",
    method: parsed?.method || "unknown",
    items: Array.isArray(parsed?.items) ? parsed.items : [],
    notes: parsed?.notes || "",
  };

  const validation = tryValidate("import.preservation", base);

  const sessions = [
    {
      type: "preservation",
      label: base.title,
      method: base.method,
      items: base.items,
    },
  ];

  // preservation can alter inventory (raw → preserved)
  const inventoryChanges = Array.isArray(parsed?.inventoryChanges)
    ? parsed.inventoryChanges
    : [];

  return {
    ok: true,
    domain: "preservation",
    normalized: base,
    context: extractContextIntelligence("preservation", base),
    sessions,
    inventoryChanges,
    storehouseChanges: [],
    warnings: validation.ok
      ? validation.warnings
      : ["Preservation import not fully valid", ...validation.warnings],
  };
}

// -----------------------------------------------------------------------------
// NORMALIZERS REGISTRY
// -----------------------------------------------------------------------------
const NORMALIZERS = {
  recipe: normalizeRecipe,
  cleaning: normalizeCleaning,
  garden: normalizeGarden,
  animal: normalizeAnimal,
  storehouse: normalizeStorehouse,
  howto: normalizeHowTo,
  preservation: normalizePreservation,
};

// -----------------------------------------------------------------------------
// MAIN ENTRY
// - input: { domain, parsed, raw, meta }
// - returns normalized object (see top)
// -----------------------------------------------------------------------------
async function normalizeImport({ domain, parsed, raw, meta = {} } = {}) {
  if (!domain) {
    const out = {
      ok: false,
      error: "Missing domain for normalization.",
    };
    emitImportEvent("import.normalized.error", out);
    return out;
  }

  const normalizer = NORMALIZERS[domain];
  if (!normalizer) {
    const out = {
      ok: false,
      error: `No normalizer registered for domain "${domain}".`,
    };
    emitImportEvent("import.normalized.error", out);
    return out;
  }

  const result = normalizer({ parsed, raw, meta });

  // Emit success/warning events
  emitImportEvent("import.normalized", {
    domain,
    warnings: result.warnings,
    // don't emit potentially huge payloads in full — clip
    preview: {
      title: result.normalized?.title,
      sessions: Array.isArray(result.sessions) ? result.sessions.length : 0,
      inventoryChanges: Array.isArray(result.inventoryChanges)
        ? result.inventoryChanges.length
        : 0,
      storehouseChanges: Array.isArray(result.storehouseChanges)
        ? result.storehouseChanges.length
        : 0,
    },
  });

  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    emitImportEvent("import.normalized.warning", {
      domain,
      warnings: result.warnings,
    });
  }

  // If this normalization is already a data-changing import, ship to Hub
  const hasDataChanges =
    (Array.isArray(result.inventoryChanges) &&
      result.inventoryChanges.length > 0) ||
    (Array.isArray(result.storehouseChanges) &&
      result.storehouseChanges.length > 0) ||
    (Array.isArray(result.sessions) && result.sessions.length > 0);

  if (hasDataChanges) {
    await exportToHubIfEnabled({
      kind: "import.normalized",
      domain,
      data: result,
      ts: new Date().toISOString(),
    });
  }

  return result;
}

// -----------------------------------------------------------------------------
// Allow runtime registration (SSA loads community / user domain)
// -----------------------------------------------------------------------------
function registerNormalizer(domain, fn) {
  if (!domain || typeof fn !== "function") return;
  NORMALIZERS[domain] = fn;
  emitImportEvent("import.normalized.registered", { domain });
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
const ImportNormalizer = {
  normalizeImport,
  registerNormalizer,
  __extractContextIntelligence: extractContextIntelligence,
  __tryValidate: tryValidate,
};

export default ImportNormalizer;
