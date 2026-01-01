// C:\Users\larho\suka-smart-assistant\src\workers\import.worker.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Import Worker
// -----------------------------------------------------------------------------
// What this worker does:
// 1. Receives raw imports from bookmarklet / public shortcut page / upload / linked accounts
//    (recipes, cleaning routines, garden seeds, harvest logs, storehouse goals, animal/butchery plans)
// 2. Normalizes to DOMAIN-AWARE envelopes, so your app can fan them out consistently
// 3. Emits “save as favorite session/schedule” suggestions back to main thread
// 4. Supports *reverse generation* (e.g. recipe → animals, harvest → storehouse, storehouse → cleaning)
// 5. Respects the shared orchestration you wired in automation/runtime.js:
//    it will always try to emit the canonical `automation.schedule.request` shape
//
// Design notes:
// - Workers can’t reach window/eventBus directly, so we postMessage back with an ACTION,
//   your main thread (ImportService / ImportRouter / shared orchestration) re-emits to the bus.
// - We keep it defensive. If a field isn’t there, we leave it in `meta.unmapped`.
// - We include grocery-section inspiration for storehouse imports.
// - We include user favorites support by emitting a “favorite/request” message.
//
// -----------------------------------------------------------------------------
// MESSAGE SHAPE FROM MAIN THREAD
// -----------------------------------------------------------------------------
// self.postMessage({ type: "IMPORT", payload: { source, kind, raw, meta? } })
//
// Example payloads we expect:
// { kind: "recipe", raw: {...}, meta: { from: "bookmarklet", url: "..." } }
// { kind: "seed", raw: {...}, meta: { ocr: true } }
// { kind: "cleaning", raw: {...}, meta: {...} }
//
// -----------------------------------------------------------------------------
// MESSAGE SHAPE TO MAIN THREAD
// -----------------------------------------------------------------------------
// 1) Normalized import for domain routing:
// {
//   type: "import.normalized",
//   payload: { domain, action, data, meta, reverse?, schedule? }
// }
//
// 2) Request to schedule via automation.runtime:
// {
//   type: "automation.schedule.request",
//   payload: { templateId, title, rule, ctx, meta }
// }
//
// 3) Request to save user favorite (session / schedule):
// {
//   type: "favorite.request",
//   payload: { entity: "session" | "schedule", data: { ... } }
// }
//
// -----------------------------------------------------------------------------
// DOMAINS COVERED:
// - cleaning
// - garden (planning, care, harvest)
// - storehouse (stock planner, grocery sections)
// - meals (meal planning, cooking, recipes)
// - animals (acquisition, care, butchery – with reverse from recipes)
// -----------------------------------------------------------------------------


// ────────────────────────────── small utils ────────────────────────────────
const now = () => Date.now();
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

const DEFAULT_GROCERY_SECTIONS = [
  "produce",
  "dairy-eggs",
  "meat-seafood",
  "frozen",
  "dry-goods",
  "baking",
  "condiments",
  "fermenting/preserving",
  "bulk",
  "cleaning-supplies",
];

// we will sometimes want to tell the UI "this is favoriteable"
function emitFavoriteRequest(entity, data) {
  self.postMessage({
    type: "favorite.request",
    payload: {
      entity,
      data: {
        ...data,
        id: data.id || genId(),
        savedAt: now(),
      },
    },
  });
}

// when we see something that should be auto-scheduled, we send this back:
function emitScheduleRequest(payload) {
  self.postMessage({
    type: "automation.schedule.request",
    payload,
  });
}

// when we have a normalized import that still needs domain routing in main thread:
function emitNormalized(payload) {
  self.postMessage({
    type: "import.normalized",
    payload,
  });
}


// ─────────────────────── normalizers per domain ────────────────────────────
// Each returns { domain, action, data, meta, reverse?, schedule? }

function normalizeCleaning(input, meta = {}) {
  const src = input || {};
  const routineType = src.routineType || src.type || "standard";
  const zones = src.zones || src.rooms || meta.zones || ["entry", "kitchen", "bathroom"];
  const schedule = src.schedule || meta.schedule || { at: "09:00" };

  const data = {
    id: src.id || meta.id || genId(),
    routineType,
    zones,
    declutterFirst: !!(src.declutterFirst ?? meta.declutterFirst ?? true),
    longCadence: src.longCadence || meta.longCadence || null,
    source: meta.source || "import.worker",
  };

  return {
    domain: "cleaning",
    action: "cleaning.routine.imported",
    data,
    schedule,
    meta: {
      ...meta,
      original: src,
    },
    // reverse: storehouse shelves / pantry → cleaning pass
    reverse: src.fromStorehouse ? [{ kind: "storehouse→cleaning", storehouseId: src.storehouseId || null }] : [],
  };
}

function normalizeGarden(input, meta = {}) {
  const src = input || {};
  const kind = src.kind || src.type || "seed";
  const schedule = src.schedule || meta.schedule || { at: "08:00" };

  const base = {
    id: src.id || genId(),
    source: meta.source || "import.worker",
    variety: src.variety || src.name || "",
    crop: src.crop || src.plant || "",
    sowingWindow: src.sowingWindow || src.window || null,
    spacing: src.spacing || src.plantSpacing || null,
    beds: src.beds || meta.beds || [],
    tasks: src.tasks || [],
  };

  const action =
    kind === "harvest"
      ? "garden.harvest.imported"
      : kind === "care"
      ? "garden.care.imported"
      : "garden.seed.imported";

  const reverse = [];
  // harvest → storehouse
  if (kind === "harvest" && src.yield) {
    reverse.push({
      kind: "harvest→storehouse",
      storehouse: {
        item: base.crop || base.variety || "harvested-produce",
        quantity: src.yield,
        unit: src.unit || "lb",
      },
    });
  }

  return {
    domain: "garden",
    action,
    data: base,
    schedule,
    meta: {
      ...meta,
      original: src,
    },
    reverse,
  };
}

function normalizeStorehouse(input, meta = {}) {
  const src = input || {};
  const schedule = src.schedule || meta.schedule || { at: "11:00" };
  const sections = src.sections && src.sections.length ? src.sections : DEFAULT_GROCERY_SECTIONS;

  const data = {
    id: src.id || genId(),
    name: src.name || "Storehouse Goal",
    targetDays: src.targetDays || 30,
    sections: sections.map((name) => ({
      name,
      targetQty: src[name]?.targetQty || null,
      unit: src[name]?.unit || "unit",
    })),
    source: meta.source || "import.worker",
  };

  // reverse: if they said “from harvest”, we add a reverse to harvest
  const reverse = [];
  if (src.fromHarvest) {
    reverse.push({ kind: "harvest→storehouse", harvestRef: src.harvestRef || null });
  }

  // reverse: storehouse shelves → cleaning
  if (src.needsCleaning || src.auditOnly) {
    reverse.push({ kind: "storehouse→cleaning", shelves: src.shelves || "all" });
  }

  return {
    domain: "storehouse",
    action: "storehouse.plan.imported",
    data,
    schedule,
    meta: {
      ...meta,
      original: src,
    },
    reverse,
  };
}

function normalizeMeals(input, meta = {}) {
  const src = input || {};
  const schedule = src.schedule || meta.schedule || { at: "15:00", days: [0] }; // Sunday batch

  const data = {
    id: src.id || genId(),
    title: src.title || src.name || "Imported Recipe / Meal Plan",
    recipes: Array.isArray(src.recipes) ? src.recipes : src.recipe ? [src.recipe] : [],
    sourceUrl: src.url || src.href || meta.url || null,
    source: meta.source || "import.worker",
    inventoryAware: !!(src.inventoryAware ?? true),
  };

  // reverse: recipes → animals (for butchery planning)
  const reverse = [];
  if (data.recipes.length) {
    reverse.push({ kind: "recipes→animals", recipes: data.recipes });
    reverse.push({ kind: "recipes→garden", recipes: data.recipes });
  }

  return {
    domain: "meals",
    action: "mealplan.imported",
    data,
    schedule,
    meta: {
      ...meta,
      original: src,
    },
    reverse,
  };
}

function normalizeAnimals(input, meta = {}) {
  const src = input || {};
  const schedule = src.schedule || meta.schedule || { at: "07:00" };

  const data = {
    id: src.id || genId(),
    title: src.title || "Animal Plan",
    species: src.species || src.animal || "sheep",
    count: src.count || 1,
    includeBreeds: !!(src.includeBreeds ?? true),
    includeMeatEstimates: !!(src.includeMeatEstimates ?? true),
    source: meta.source || "import.worker",
  };

  // reverse: animals → meals (when butchery is declared)
  const reverse = [];
  if (src.forButchery) {
    reverse.push({ kind: "animals→meals", animals: [{ species: data.species, count: data.count }] });
    reverse.push({ kind: "animals→storehouse", animals: [{ species: data.species, count: data.count }] });
  }

  return {
    domain: "animals",
    action: "animals.plan.imported",
    data,
    schedule,
    meta: {
      ...meta,
      original: src,
    },
    reverse,
  };
}


// ───────────────────────── central dispatcher ──────────────────────────────
function normalizeImport({ kind, raw, meta = {} }) {
  // We keep the kinds consistent with what you’ve been emitting:
  // "recipe", "cleaning", "garden", "seed", "harvest", "storehouse", "mealplan", "animals", "butchery"
  const k = (kind || meta.kind || "").toLowerCase();

  if (k === "cleaning") return normalizeCleaning(raw, meta);
  if (k === "garden" || k === "seed" || k === "harvest" || k === "garden-care")
    return normalizeGarden({ ...raw, kind: k === "seed" ? "seed" : k === "harvest" ? "harvest" : "care" }, meta);
  if (k === "storehouse" || k === "stock" || k === "pantry") return normalizeStorehouse(raw, meta);
  if (k === "mealplan" || k === "recipe" || k === "cooking") return normalizeMeals(raw, meta);
  if (k === "animals" || k === "butchery" || k === "animal-care") return normalizeAnimals(raw, meta);

  // fallback: try to infer
  if (isObj(raw)) {
    if (raw?.recipe || raw?.recipes) return normalizeMeals(raw, meta);
    if (raw?.variety || raw?.crop) return normalizeGarden(raw, meta);
    if (raw?.routineType || raw?.zones) return normalizeCleaning(raw, meta);
    if (raw?.sections) return normalizeStorehouse(raw, meta);
  }

  // unknown / passthrough
  return {
    domain: "unknown",
    action: "import.unknown",
    data: raw,
    schedule: null,
    meta: { ...meta, reason: "unrecognized-kind" },
    reverse: [],
  };
}


// ─────────────────────────── reverse generation ─────────────────────────────
// The worker does not actually RUN reverse generation (that belongs to your
// automation runtime + domain services). Instead, we emit instructions for main
// thread to fan out. This keeps the worker simple and offline-safe.
//
function emitReverseTasks(domain, reverseList, baseMeta = {}) {
  if (!Array.isArray(reverseList) || reverseList.length === 0) return;
  reverseList.forEach((rev, idx) => {
    const payload = {
      type: "reverse.action.request",
      payload: {
        id: genId(),
        domain,
        ...rev,
        meta: {
          ...baseMeta,
          index: idx,
          source: baseMeta.source || "import.worker",
        },
      },
    };
    self.postMessage(payload);
  });
}


// ─────────────────────────── message listener ──────────────────────────────
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  const { type, payload } = msg;

  if (type === "PING") {
    self.postMessage({ type: "PONG", ts: now() });
    return;
  }

  if (type !== "IMPORT") {
    // passthrough
    self.postMessage({ type: "import.ignored", payload: { receivedType: type } });
    return;
  }

  // normalize
  const normalized = normalizeImport(payload || {});
  emitNormalized(normalized);

  // favorites: if meta says “favoriteMe” or if it’s user-triggered, emit favorite request
  if (payload?.meta?.favoriteMe || payload?.meta?.source === "shortcut-download") {
    emitFavoriteRequest("session", {
      title: `[${normalized.domain}] ${normalized.action}`,
      domain: normalized.domain,
      payload: normalized.data,
      source: payload?.meta?.source || "import.worker",
    });
  }

  // schedule: if there is a schedule, ask automation to persist it
  if (normalized.schedule) {
    emitScheduleRequest({
      title: `${capitalize(normalized.domain)} – Imported`,
      templateId: templateIdForDomain(normalized.domain),
      rule: normalized.schedule,
      ctx: {
        ...normalized.data,
        domain: normalized.domain,
      },
      meta: {
        domain: normalized.domain,
        source: payload?.meta?.source || "import.worker",
      },
    });
  }

  // reverse: tell main thread to emit domain-specific reverse actions
  if (normalized.reverse && normalized.reverse.length) {
    emitReverseTasks(normalized.domain, normalized.reverse, normalized.meta || {});
  }
});


// ─────────────────────────── helpers (domain → template) ───────────────────
function templateIdForDomain(domain) {
  switch (domain) {
    case "cleaning":
      return "cleaning.session.generate";
    case "garden":
      return "garden.session.generate";
    case "storehouse":
      return "storehouse.session.generate";
    case "meals":
      // you also have `mealplan.session.generate` in some chats
      return "cooking.session.generate";
    case "animals":
      return "animals.session.generate";
    default:
      return "generic.session.generate";
  }
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
