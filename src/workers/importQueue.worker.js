// C:\Users\larho\suka-smart-assistant\src\workers\importQueue.worker.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Import Queue Worker
// -----------------------------------------------------------------------------
// PURPOSE
// This worker sits *next to* import.worker.js and gives you a proper,
// offline-friendly, domain-aware IMPORT QUEUE with:
//  - cleaning
//  - garden (planning, care, harvest)
//  - storehouse stock planning (grocery sections)
//  - meal planning / cooking
//  - animal acquisition, care, butchery
//  - reverse generation fan-out (recipes → animals/garden, harvest → storehouse,
//    storehouse → cleaning, animals → meals)
//  - user-owned favorites & schedules (not just system)
//  - shared orchestration: everything ultimately flows to
//    `automation.schedule.request` + `favorite.request` + domain-level events,
//    which your main thread can re-emit on window.__suka?.eventBus
//
// DESIGN
// - main thread (ImportService / ImportRouter) posts IMPORT_JOB(s) to this worker
// - worker stores them in an in-memory queue (optionally rehydrate from IndexedDB
//   via message; workers can’t open Dexie directly in all bundlers, so we let main
//   thread persist)
// - worker normalizes and PRIORITIZES jobs
// - worker emits messages back to main thread to:
//    1. actually import (import.normalized)
//    2. create schedules (automation.schedule.request)
//    3. create user favorites (favorite.request)
//    4. create reverse tasks (reverse.action.request)
//    5. notify UI (ui.toast) – optional
//
// MESSAGE SHAPES
// -----------------------------------------------------------------------------
// to worker:
//   { type: "IMPORT_QUEUE:ENQUEUE", payload: {...} }
//   { type: "IMPORT_QUEUE:ENQUEUE_BATCH", payload: [ {...}, {...} ] }
//   { type: "IMPORT_QUEUE:FLUSH" }
//   { type: "IMPORT_QUEUE:STATE" }  -> worker replies with current state
//   { type: "IMPORT_QUEUE:RESTORE", payload: { jobs: [...] } }  -> restore from main thread
//
// from worker:
//   { type: "import.normalized", payload: {...} }   <- send to import.worker.js handler
//   { type: "automation.schedule.request", payload: {...} }
//   { type: "favorite.request", payload: {...} }
//   { type: "reverse.action.request", payload: {...} }
//   { type: "IMPORT_QUEUE:STATE", payload: {...} }
//   { type: "ui.toast", payload: {...} }
//
// IMPORTANT
// - This worker does NOT do DOM stuff.
// - It just decides “this is cleaning → schedule it and let user favorite it”.
// - Your main thread must re-emit to window.__suka?.eventBus, automation, etc.
// -----------------------------------------------------------------------------


/* ─────────────────────────────── utils ─────────────────────────────────── */
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

const DOMAIN_TO_TEMPLATE = {
  cleaning: "cleaning.session.generate",
  garden: "garden.session.generate",
  storehouse: "storehouse.session.generate",
  meals: "cooking.session.generate", // alias for mealplan
  animals: "animals.session.generate",
  reverse: "reverse.session.generate",
  generic: "generic.session.generate",
};


/* ────────────────────────────── job shape ────────────────────────────────
  {
    id: string,
    priority: 0|1|2,
    createdAt: number,
    payload: {
      kind, raw, meta
    }
  }
--------------------------------------------------------------------------- */
const queue = [];
let processing = false;


/* ────────────────────────────── helpers to emit ─────────────────────────── */
function emit(msg) {
  self.postMessage(msg);
}

function emitNormalized(payload) {
  emit({ type: "import.normalized", payload });
}

function emitSchedule(payload) {
  emit({ type: "automation.schedule.request", payload });
}

function emitFavorite(entity, data) {
  emit({
    type: "favorite.request",
    payload: {
      entity,
      data: {
        ...data,
        id: data?.id || genId(),
        savedAt: now(),
      },
    },
  });
}

function emitReverse(domain, reverseList, baseMeta = {}) {
  if (!reverseList || !reverseList.length) return;
  reverseList.forEach((rev, idx) => {
    emit({
      type: "reverse.action.request",
      payload: {
        id: genId(),
        domain,
        ...rev,
        meta: {
          ...baseMeta,
          index: idx,
          source: baseMeta.source || "importQueue.worker",
        },
      },
    });
  });
}

function emitToast(title, message, variant = "info") {
  emit({
    type: "ui.toast",
    payload: { title, message, variant, ts: now(), source: "importQueue.worker" },
  });
}

function currentState() {
  return {
    ts: now(),
    queued: queue.map((j) => ({
      id: j.id,
      priority: j.priority,
      kind: j.payload?.kind,
      meta: j.payload?.meta || null,
    })),
    processing,
  };
}


/* ────────────────────────────── DOMAIN NORMALS ──────────────────────────── */
function normalizeCleaning(raw, meta = {}) {
  const routineType = raw.routineType || raw.type || "standard";
  const zones = raw.zones || raw.rooms || meta.zones || ["entry", "kitchen", "bathroom"];
  const schedule = raw.schedule || meta.schedule || { at: "09:00" };
  const data = {
    id: raw.id || meta.id || genId(),
    routineType,
    zones,
    declutterFirst: !!(raw.declutterFirst ?? meta.declutterFirst ?? true),
    source: meta.source || "importQueue.worker",
  };
  const reverse = [];
  // storehouse → cleaning
  if (meta.fromStorehouse || raw.fromStorehouse) {
    reverse.push({ kind: "storehouse→cleaning", shelves: raw.shelves || "all" });
  }
  return {
    domain: "cleaning",
    action: "cleaning.routine.imported",
    data,
    schedule,
    meta: { ...meta, original: raw },
    reverse,
  };
}

function normalizeGarden(raw, meta = {}) {
  const kind = raw.kind || raw.type || "seed";
  const schedule = raw.schedule || meta.schedule || { at: "08:00" };

  const data = {
    id: raw.id || genId(),
    variety: raw.variety || raw.name || "",
    crop: raw.crop || raw.plant || "",
    sowingWindow: raw.sowingWindow || raw.window || null,
    spacing: raw.spacing || raw.plantSpacing || null,
    beds: raw.beds || meta.beds || [],
    tasks: raw.tasks || [],
    source: meta.source || "importQueue.worker",
  };

  const action =
    kind === "harvest"
      ? "garden.harvest.imported"
      : kind === "care"
      ? "garden.care.imported"
      : "garden.seed.imported";

  const reverse = [];
  // harvest → storehouse
  if (kind === "harvest" && (raw.yield || raw.qty)) {
    reverse.push({
      kind: "harvest→storehouse",
      storehouse: {
        item: data.crop || data.variety || "harvested-produce",
        quantity: raw.yield || raw.qty,
        unit: raw.unit || "lb",
      },
    });
  }

  return {
    domain: "garden",
    action,
    data,
    schedule,
    meta: { ...meta, original: raw },
    reverse,
  };
}

function normalizeStorehouse(raw, meta = {}) {
  const schedule = raw.schedule || meta.schedule || { at: "11:00" };
  const sections = raw.sections && raw.sections.length ? raw.sections : DEFAULT_GROCERY_SECTIONS;

  const data = {
    id: raw.id || genId(),
    name: raw.name || "Storehouse Goal",
    targetDays: raw.targetDays || 30,
    sections: sections.map((name) => ({
      name,
      targetQty: raw[name]?.targetQty || null,
      unit: raw[name]?.unit || "unit",
    })),
    source: meta.source || "importQueue.worker",
  };

  const reverse = [];
  // “need to clear shelves” → cleaning
  if (raw.needsCleaning || meta.needsCleaning) {
    reverse.push({ kind: "storehouse→cleaning", shelves: raw.shelves || "all" });
  }
  // “from harvest” → storehouse
  if (raw.fromHarvest) {
    reverse.push({ kind: "harvest→storehouse", harvestRef: raw.harvestRef || null });
  }

  return {
    domain: "storehouse",
    action: "storehouse.plan.imported",
    data,
    schedule,
    meta: { ...meta, original: raw },
    reverse,
  };
}

function normalizeMeals(raw, meta = {}) {
  const schedule = raw.schedule || meta.schedule || { at: "15:00", days: [0] }; // Sunday
  const data = {
    id: raw.id || genId(),
    title: raw.title || raw.name || "Imported Recipe / Meal Plan",
    recipes: Array.isArray(raw.recipes) ? raw.recipes : raw.recipe ? [raw.recipe] : [],
    sourceUrl: raw.url || raw.href || meta.url || null,
    source: meta.source || "importQueue.worker",
    inventoryAware: !!(raw.inventoryAware ?? true),
  };
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
    meta: { ...meta, original: raw },
    reverse,
  };
}

function normalizeAnimals(raw, meta = {}) {
  const schedule = raw.schedule || meta.schedule || { at: "07:00" };
  const data = {
    id: raw.id || genId(),
    title: raw.title || "Animal Plan",
    species: raw.species || raw.animal || "sheep",
    count: raw.count || 1,
    includeBreeds: !!(raw.includeBreeds ?? true),
    includeMeatEstimates: !!(raw.includeMeatEstimates ?? true),
    source: meta.source || "importQueue.worker",
  };
  const reverse = [];
  if (raw.forButchery) {
    reverse.push({ kind: "animals→meals", animals: [{ species: data.species, count: data.count }] });
    reverse.push({ kind: "animals→storehouse", animals: [{ species: data.species, count: data.count }] });
  }
  // reverse from meals: “generate animal plan from recipes”
  if (raw.fromRecipes && Array.isArray(raw.fromRecipes) && raw.fromRecipes.length) {
    reverse.push({ kind: "recipes→animals", recipes: raw.fromRecipes });
  }

  return {
    domain: "animals",
    action: "animals.plan.imported",
    data,
    schedule,
    meta: { ...meta, original: raw },
    reverse,
  };
}


function normalizeGeneric(raw, meta = {}) {
  return {
    domain: "generic",
    action: "import.unknown",
    data: raw,
    schedule: null,
    meta: { ...meta, reason: "unrecognized-kind" },
    reverse: [],
  };
}


// central normalize
function normalizeJob(jobPayload) {
  const { kind, raw, meta = {} } = jobPayload || {};
  const k = (kind || meta.kind || "").toLowerCase();

  if (k === "cleaning") return normalizeCleaning(raw, meta);
  if (k === "garden" || k === "seed" || k === "harvest" || k === "garden-care")
    return normalizeGarden({ ...raw, kind: k === "seed" ? "seed" : k === "harvest" ? "harvest" : "care" }, meta);
  if (k === "storehouse" || k === "stock" || k === "pantry") return normalizeStorehouse(raw, meta);
  if (k === "mealplan" || k === "recipe" || k === "cooking") return normalizeMeals(raw, meta);
  if (k === "animals" || k === "butchery" || k === "animal-care") return normalizeAnimals(raw, meta);

  // attempt inference
  if (isObj(raw)) {
    if (raw.recipe || raw.recipes) return normalizeMeals(raw, meta);
    if (raw.variety || raw.crop) return normalizeGarden(raw, meta);
    if (raw.routineType || raw.zones) return normalizeCleaning(raw, meta);
    if (raw.sections) return normalizeStorehouse(raw, meta);
  }

  return normalizeGeneric(raw, meta);
}


/* ────────────────────────────── queue ops ───────────────────────────────── */
function enqueue(job) {
  queue.push(job);
  // highest priority first, then oldest
  queue.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
}

async function processNext() {
  if (processing) return;
  const job = queue.shift();
  if (!job) return;
  processing = true;

  try {
    const normalized = normalizeJob(job.payload);

    // 1) tell main thread to route to domain
    emitNormalized(normalized);

    // 2) favorites (user-owned)
    if (job.payload?.meta?.favoriteMe || normalized.meta?.favoriteMe || job.payload?.meta?.source === "shortcut-download") {
      emitFavorite("session", {
        title: `[${normalized.domain}] ${normalized.action}`,
        domain: normalized.domain,
        payload: normalized.data,
        source: normalized.meta?.source || job.payload?.meta?.source || "importQueue.worker",
      });
    }

    // 3) schedule
    if (normalized.schedule) {
      emitSchedule({
        title: `${capitalize(normalized.domain)} – Imported`,
        templateId: DOMAIN_TO_TEMPLATE[normalized.domain] || DOMAIN_TO_TEMPLATE.generic,
        rule: normalized.schedule,
        ctx: {
          ...normalized.data,
          domain: normalized.domain,
        },
        meta: {
          domain: normalized.domain,
          source: normalized.meta?.source || "importQueue.worker",
        },
      });
    }

    // 4) reverse generation
    if (normalized.reverse && normalized.reverse.length) {
      emitReverse(normalized.domain, normalized.reverse, normalized.meta || {});
    }

    // 5) nice UI message
    emitToast(
      `Imported ${normalized.domain}`,
      `We saved your ${normalized.domain} import${
        normalized.schedule ? " and scheduled it" : ""
      }. You can edit it in the appropriate page.`,
      "success"
    );
  } catch (err) {
    emitToast("Import failed", String(err && err.message ? err.message : err), "error");
  } finally {
    processing = false;
    // process next immediately if exists
    if (queue.length) {
      // small microtask-yield
      setTimeout(processNext, 0);
    }
    // publish state
    emit({ type: "IMPORT_QUEUE:STATE", payload: currentState() });
  }
}


/* ────────────────────────────── message bus ─────────────────────────────── */
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  const { type, payload } = msg;

  switch (type) {
    case "PING": {
      emit({ type: "PONG", ts: now(), queue: currentState() });
      break;
    }

    case "IMPORT_QUEUE:ENQUEUE": {
      // payload is { kind, raw, meta }
      enqueue({
        id: payload?.id || genId(),
        priority: payload?.meta?.priority ?? 1,
        createdAt: now(),
        payload,
      });
      processNext();
      break;
    }

    case "IMPORT_QUEUE:ENQUEUE_BATCH": {
      const list = Array.isArray(payload) ? payload : [];
      list.forEach((item) => {
        enqueue({
          id: item?.id || genId(),
          priority: item?.meta?.priority ?? 1,
          createdAt: now(),
          payload: item,
        });
      });
      processNext();
      break;
    }

    case "IMPORT_QUEUE:FLUSH": {
      // process ALL immediately
      if (!processing && queue.length) {
        processNext();
      }
      break;
    }

    case "IMPORT_QUEUE:STATE": {
      emit({ type: "IMPORT_QUEUE:STATE", payload: currentState() });
      break;
    }

    case "IMPORT_QUEUE:RESTORE": {
      // main thread is giving us a saved queue (e.g. from IndexedDB/Dexie)
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      jobs.forEach((j) => {
        enqueue({
          id: j.id || genId(),
          priority: j.priority ?? 1,
          createdAt: j.createdAt || now(),
          payload: j.payload || {},
        });
      });
      emitToast("Imports restored", "We restored your pending imports from storage.", "info");
      processNext();
      break;
    }

    default: {
      // unknown command
      emit({ type: "IMPORT_QUEUE:IGNORED", payload: { receivedType: type } });
      break;
    }
  }
});


/* ────────────────────────────── helpers ─────────────────────────────────── */
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
