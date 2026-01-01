// C:\Users\larho\suka-smart-assistant\src\domain\animals\AnimalSessionEngine.js
// Generates animal-care sessions and cut plans
// -----------------------------------------------------------------------------
// HOW THIS FITS THE SSA PIPELINE
// imports (animal/butchery guides, breed specs, dairy/milking routines, coop-cleaning,
// feed-ration calculators, video/how-to)
//   → ImportService → normalized animal payloads
//   → AnimalPlanner.jsx (user picked species, pens, care cadence, butchery dates)
//   → AnimalSessionEngine (THIS FILE) turns those planner items *or* direct imports into
//       actionable SESSIONS:
//         1. animal care sessions (feed, water, rotate pasture, clean coop, trim, medicate)
//         2. butchery / slaughter sessions (with cut plan, yields, by-products)
//         3. optional storehouse updates (tallow, bones, hides, organs)
//         4. optional preservation follow-ups (render fat, brine, cure, grind)
//   → emits to shared eventBus:
//         - animal.session.generated
//         - animal.executed
//         - inventory.updated (when meat/eggs/milk added OR feed consumed)
//         - storehouse.updated (when hides/fat/bones recorded)
//         - preservation.request (optional handoff)
//   → if featureFlags.familyFundMode === true → exportToHubIfEnabled(...) is called
//
// DESIGN
// - Forward-thinking: supports domains "animal", "butchery", "livestock", "dairy", "forage",
//   "storehouse", and "preservation" as *extensions*.
// - Defensive: if cut-planning/yield-curve services don’t exist, we still return a valid session.
// - Consistent payload shape: { type, ts, source, data }.
//
// ASSUMED / SOFT-DEPS (we guard require() so the file still works):
// - src/services/eventBus.js
// - src/config/featureFlags.json
// - src/services/HubPacketFormatter.js → formatAnimalSessionForHub
// - src/services/FamilyFundConnector.js
// - src/services/animals/AnimalSessionStore.js → save(session), markExecuted(sessionId, actuals)
// - src/services/animals/AnimalYieldCurveService.js → getCurveFor(speciesOrBreed)
// - src/services/animals/AnimalCutPlanner.js → planCutsFromCurve(curve, options)
//
// PUBLIC API
//   AnimalSessionEngine.generateFromPlan(plan, options?)
//   AnimalSessionEngine.generateFromImports(importsArray, options?)
//   AnimalSessionEngine.generateSingleSession(animalItems, options?)
//   AnimalSessionEngine.onSessionExecuted(sessionId, actuals)
//
// NOTE
// - This is the ANIMAL mirror of your CleaningSessionEngine and GardenSessionEngine.
// - It is written to drop straight into your event-driven SSA runtime.

import eventBus from "../../services/eventBus";
import featureFlags from "../../config/featureFlags.json";
import { formatAnimalSessionForHub } from "../../services/HubPacketFormatter";
import FamilyFundConnector from "../../services/FamilyFundConnector";

let AnimalSessionStore = null;
let AnimalYieldCurveService = null;
let AnimalCutPlanner = null;

try {
  // eslint-disable-next-line global-require
  AnimalSessionStore = require("./AnimalSessionStore.js");
} catch (e) {
  AnimalSessionStore = null;
}

try {
  // eslint-disable-next-line global-require
  AnimalYieldCurveService = require("../../services/animals/AnimalYieldCurveService.js");
} catch (e) {
  AnimalYieldCurveService = null;
}

try {
  // eslint-disable-next-line global-require
  AnimalCutPlanner = require("../../services/animals/AnimalCutPlanner.js");
} catch (e) {
  AnimalCutPlanner = null;
}

const SOURCE_ID = "domain.animals.AnimalSessionEngine";

const AnimalSessionEngine = {
  /**
   * Generate sessions (care + butchery) from an AnimalPlanner plan
   * @param {Object} plan - { id, items: [{species, breed, qty, pen, care, butcherAt, ...}] }
   * @param {Object} options - { policy: "pens-first"|"species-first"|"butchery-only", attachCuts: true }
   * @returns {Promise<Array>}
   */
  async generateFromPlan(plan, options = {}) {
    if (!plan || !Array.isArray(plan.items)) {
      console.warn("[AnimalSessionEngine] generateFromPlan: invalid plan");
      return [];
    }

    const policy = options.policy || "pens-first";
    const attachCuts = options.attachCuts ?? true;

    // group animals according to policy
    const grouped = groupAnimalItems(plan.items, policy);

    const sessions = [];
    for (const group of grouped) {
      const session = await buildAnimalSessionFromItems(group, {
        planId: plan.id,
        policy,
        attachCuts,
      });
      sessions.push(session);
    }

    // persist + emit each
    for (const s of sessions) {
      const saved = await persistSession(s);
      const evt = emitEvent("animal.session.generated", { session: saved });
      await exportToHubIfEnabled(evt);
    }

    return sessions;
  },

  /**
   * Reverse generation: user imported an animal/butchery schedule
   * @param {Array} importsArray
   * @param {Object} options
   * @returns {Promise<Array>}
   */
  async generateFromImports(importsArray, options = {}) {
    if (!Array.isArray(importsArray) || !importsArray.length) {
      console.warn("[AnimalSessionEngine] generateFromImports: empty imports");
      return [];
    }

    const items = importsArray
      .map((imp) => normalizeImportToAnimalItem(imp))
      .filter(Boolean);

    return this.generateSingleSession(items, {
      ...options,
      source: "imports.direct",
    });
  },

  /**
   * Generate ONE session from an array of animal items
   * @param {Array} animalItems
   * @param {Object} options
   * @returns {Promise<Array>} just 1 session in an array
   */
  async generateSingleSession(animalItems, options = {}) {
    if (!Array.isArray(animalItems) || !animalItems.length) {
      console.warn("[AnimalSessionEngine] generateSingleSession: no items");
      return [];
    }

    const session = await buildAnimalSessionFromItems(animalItems, {
      planId: options.planId || null,
      policy: options.policy || "single-pen",
      attachCuts: options.attachCuts ?? true,
      source: options.source || "ui.single-session",
    });

    const saved = await persistSession(session);
    const evt = emitEvent("animal.session.generated", { session: saved });
    await exportToHubIfEnabled(evt);

    return [saved];
  },

  /**
   * Called by runtime when the session is executed / completed.
   * @param {string} sessionId
   * @param {Object} actuals
   *  actuals = {
   *    careCompleted: [...],
   *    animalsButchered: [{species, breed, liveWeight?, yieldCurveKey?, parts: [...] }],
   *    suppliesUsed: [...],
   *    byproducts: [...],
   *  }
   */
  async onSessionExecuted(sessionId, actuals = {}) {
    let session = null;
    if (AnimalSessionStore && typeof AnimalSessionStore.markExecuted === "function") {
      session = await AnimalSessionStore.markExecuted(sessionId, actuals);
    }

    const baseEvt = emitEvent("animal.executed", {
      sessionId,
      actuals,
      session,
    });
    await exportToHubIfEnabled(baseEvt);

    // 1. If we have butchered animals → inventory.updated
    if (Array.isArray(actuals.animalsButchered) && actuals.animalsButchered.length) {
      const invDeltas = [];
      actuals.animalsButchered.forEach((ab) => {
        // parts might already be computed (preferred)
        if (Array.isArray(ab.parts) && ab.parts.length) {
          ab.parts.forEach((p) => {
            invDeltas.push({
              item: p.name,
              qty: p.qty,
              unit: p.unit || "lb",
              direction: "increment",
              tags: ["butchery", ab.species || ""].filter(Boolean),
            });
          });
        } else {
          // fallback: we just log "meat (species)"
          invDeltas.push({
            item: `meat (${ab.species || "animal"})`,
            qty: ab.estimatedMeat || 1,
            unit: "lb",
            direction: "increment",
            tags: ["butchery"],
          });
        }
      });
      const invEvt = emitEvent("inventory.updated", {
        sourceSessionId: sessionId,
        deltas: invDeltas,
      });
      await exportToHubIfEnabled(invEvt);
    }

    // 2. Supplies used for care → inventory.updated (decrement)
    if (Array.isArray(actuals.suppliesUsed) && actuals.suppliesUsed.length) {
      const invEvt2 = emitEvent("inventory.updated", {
        sourceSessionId: sessionId,
        deltas: actuals.suppliesUsed.map((sup) => ({
          item: sup.inventoryLink || sup.name,
          qty: sup.qty,
          unit: sup.unit || "ea",
          direction: "decrement",
        })),
      });
      await exportToHubIfEnabled(invEvt2);
    }

    // 3. By-products → storehouse.updated
    if (Array.isArray(actuals.byproducts) && actuals.byproducts.length) {
      const storeEvt = emitEvent("storehouse.updated", {
        sourceSessionId: sessionId,
        items: actuals.byproducts.map((bp) => ({
          item: bp.name,
          qty: bp.qty,
          unit: bp.unit || "ea",
          notes: bp.notes || "",
        })),
      });
      await exportToHubIfEnabled(storeEvt);
    }

    // 4. If user wants immediate preservation → preservation.request
    if (Array.isArray(actuals.animalsButchered) && actuals.animalsButchered.some((ab) => ab.requestPreservation)) {
      const presEvt = emitEvent("preservation.request", {
        sourceSessionId: sessionId,
        reason: "fresh-butchery",
      });
      await exportToHubIfEnabled(presEvt);
    }
  },
};

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

/**
 * Group animal items by policy:
 * - "pens-first" (default) → group by pen
 * - "species-first" → group by species
 * - "butchery-only" → group only animals that have a butcherAt
 */
function groupAnimalItems(items, policy) {
  if (!Array.isArray(items) || !items.length) return [];

  if (policy === "butchery-only") {
    return [items.filter((it) => !!it.butcherAt)];
  }

  if (policy === "species-first") {
    const map = {};
    items.forEach((it) => {
      const key = it.species || "Unassigned";
      if (!map[key]) map[key] = [];
      map[key].push(it);
    });
    return Object.values(map);
  }

  // default: pens-first
  const map = {};
  items.forEach((it) => {
    const key = it.pen || "Unassigned";
    if (!map[key]) map[key] = [];
    map[key].push(it);
  });
  return Object.values(map);
}

/**
 * Build a single animal session from a group of animal items.
 * Creates CARE tasks first, then BUTCHERY tasks (if any have a date ~today).
 * @param {Array} items
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function buildAnimalSessionFromItems(items, ctx = {}) {
  const id = makeId("animalSess");
  const nowIso = new Date().toISOString();

  const careTasks = buildCareTasks(items);
  const butcheryTasks = await buildButcheryTasks(items, ctx.attachCuts);

  const tasks = [...careTasks, ...butcheryTasks];

  const supplies = collectSuppliesFromTasks(tasks);
  const equipment = collectEquipmentFromTasks(tasks);

  const totalDuration = tasks.reduce((sum, t) => sum + (Number(t.duration) || 10), 0);

  const session = {
    id,
    ts: nowIso,
    domain: "animal",
    source: SOURCE_ID,
    planId: ctx.planId || null,
    title: makeSessionTitle(items, ctx.policy),
    tasks,
    supplies,
    equipment,
    schedule: {
      start: nowIso,
      estimatedEnd: estimateEndTime(nowIso, totalDuration),
      policy: ctx.policy || "pens-first",
    },
    meta: buildMeta(items, ctx),
    status: "pending",
  };

  return session;
}

/**
 * CARE TASKS
 * Each animal item can have an array of care entries:
 *   { type: "feed"|"water"|"clean-coop"|"rotate-pasture"|"trim"|"vaccinate", every: "1d" }
 * We flatten them into actionable tasks for THIS session.
 */
function buildCareTasks(items) {
  const tasks = [];
  items.forEach((it, idx) => {
    const baseOrder = idx * 10;
    const careArr = it.care || [];
    careArr.forEach((c, cIdx) => {
      tasks.push({
        id: makeId("animalTask"),
        order: baseOrder + cIdx + 1,
        label: buildCareLabel(it, c),
        type: "care",
        careType: c.type,
        pen: it.pen || "Unassigned",
        species: it.species,
        qty: it.qty || 1,
        duration: estimateCareDuration(c.type, it.qty),
        supplies: guessSuppliesFromCare(c, it),
        equipment: guessEquipmentFromCare(c, it),
        tags: ["care"],
      });
    });
  });
  return tasks;
}

/**
 * BUTCHERY / CUT TASKS
 * For any animal with a butcherAt (and the date is "now-ish"), build a butchery task.
 * If we have a yield curve and cut planner, we can build a cut plan (parts list).
 */
async function buildButcheryTasks(items, attachCuts) {
  const tasks = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const it of items) {
    if (!it.butcherAt) continue;
    const dateStr = it.butcherAt.slice(0, 10);
    // be a little lenient: if butcherAt <= today, build task
    if (dateStr > today) continue;

    let cutPlan = null;
    if (attachCuts) {
      cutPlan = await buildCutPlanForAnimal(it);
    }

    tasks.push({
      id: makeId("animalTask"),
      order: 999, // at the end
      label: `Butcher ${it.qty || 1} × ${it.species || "animal"}${it.breed ? " (" + it.breed + ")" : ""}`,
      type: "butchery",
      pen: it.pen || "Butchery / Quarantine",
      species: it.species,
      breed: it.breed || null,
      qty: it.qty || 1,
      duration: estimateButcheryDuration(it),
      cutPlan, // may be null if we don't have services
      supplies: guessSuppliesForButchery(it),
      equipment: guessEquipmentForButchery(it),
      tags: ["butchery"],
    });
  }

  return tasks;
}

/**
 * Build a cut plan from services, if available
 */
async function buildCutPlanForAnimal(it) {
  if (!AnimalYieldCurveService && !AnimalCutPlanner) return null;
  try {
    let curve = null;
    if (AnimalYieldCurveService && typeof AnimalYieldCurveService.getCurveFor === "function") {
      curve = await AnimalYieldCurveService.getCurveFor({
        species: it.species,
        breed: it.breed,
      });
    }
    if (AnimalCutPlanner && typeof AnimalCutPlanner.planCutsFromCurve === "function") {
      return await AnimalCutPlanner.planCutsFromCurve(curve, {
        qty: it.qty || 1,
        species: it.species,
        breed: it.breed,
      });
    }
    return curve
      ? {
          curveKey: curve.key,
          parts: curve.parts || [],
        }
      : null;
  } catch (e) {
    console.warn("[AnimalSessionEngine] buildCutPlanForAnimal failed", e);
    return null;
  }
}

/**
 * Collect supplies from tasks → merge by name|unit
 */
function collectSuppliesFromTasks(tasks) {
  const map = {};
  tasks.forEach((t) => {
    (t.supplies || []).forEach((sup) => {
      const key = (sup.name || "").toLowerCase() + "|" + (sup.unit || "");
      if (!map[key]) {
        map[key] = {
          name: sup.name,
          qty: Number(sup.qty) || 1,
          unit: sup.unit || "ea",
          taskRefs: [t.label],
        };
      } else {
        map[key].qty += Number(sup.qty) || 1;
        map[key].taskRefs.push(t.label);
      }
    });
  });
  return Object.values(map);
}

/**
 * Collect equipment from tasks
 */
function collectEquipmentFromTasks(tasks) {
  const set = new Set();
  tasks.forEach((t) => {
    (t.equipment || []).forEach((eq) => set.add(eq));
  });
  return Array.from(set);
}

/**
 * META for analytics and cross-domain orchestration
 */
function buildMeta(items, ctx) {
  const pens = new Set();
  const species = new Set();
  let hasButchery = false;
  let hasDairy = false;

  items.forEach((it) => {
    if (it.pen) pens.add(it.pen);
    if (it.species) species.add(it.species);
    if (it.butcherAt) hasButchery = true;
    if ((it.care || []).some((c) => c.type === "milk")) hasDairy = true;
  });

  return {
    pens: Array.from(pens),
    species: Array.from(species),
    hasButchery,
    hasDairy,
    policy: ctx.policy || "pens-first",
  };
}

// -----------------------------------------------------------------------------
// NORMALIZATION & GUESSERS
// -----------------------------------------------------------------------------

function normalizeImportToAnimalItem(imp) {
  if (!imp) return null;
  if (imp.species || imp.title) {
    return {
      id: imp.id || makeId("animal"),
      species: imp.species || imp.title,
      breed: imp.breed || "",
      qty: imp.qty || 1,
      pen: imp.pen || "Unassigned",
      care: imp.care || [],
      butcherAt: imp.butcherAt || null,
      sourceId: imp.url || imp.sourceId || null,
      tags: imp.tags || [],
      domain: imp.domain || "animal",
    };
  }
  // fallback
  return {
    id: makeId("animal"),
    species: "Imported Animal",
    breed: "",
    qty: 1,
    pen: "Unassigned",
    care: [],
    butcherAt: null,
    sourceId: imp.url || null,
    tags: ["imported"],
    domain: "animal",
  };
}

function buildCareLabel(it, care) {
  return `${care.type || "care"}: ${it.species || "animal"}${it.breed ? " (" + it.breed + ")" : ""}`;
}

function estimateCareDuration(type, qty = 1) {
  const base = 4;
  if (type === "clean-coop" || type === "clean-stall") return base + 8;
  if (type === "rotate-pasture") return base + 6;
  if (type === "vaccinate") return base + 5;
  return base + Math.floor(qty / 5);
}

function estimateButcheryDuration(it) {
  const species = (it.species || "").toLowerCase();
  if (species.includes("chicken") || species.includes("duck") || species.includes("turkey")) {
    return 25; // small livestock
  }
  if (species.includes("goat") || species.includes("sheep")) {
    return 45;
  }
  if (species.includes("cow") || species.includes("cattle")) {
    return 90;
  }
  return 40;
}

function guessSuppliesFromCare(care, it) {
  if (!care) return [];
  if (care.type === "feed") return [{ name: "feed mix (general)", qty: it.qty || 1, unit: "scoop" }];
  if (care.type === "water") return []; // not tracked
  if (care.type === "clean-coop" || care.type === "clean-stall") {
    return [{ name: "bedding / litter", qty: 1, unit: "bag" }];
  }
  if (care.type === "vaccinate") {
    return [{ name: "vaccination dose", qty: it.qty || 1, unit: "ea" }];
  }
  return [];
}

function guessEquipmentFromCare(care, it) {
  if (!care) return [];
  if (care.type === "clean-coop" || care.type === "clean-stall") return ["shovel", "rake", "sanitizer"];
  if (care.type === "feed" || care.type === "water") return ["feed-bucket"];
  if (care.type === "rotate-pasture") return ["gate-keys"];
  if (care.type === "vaccinate") return ["medical-kit"];
  return ["general-animal-kit"];
}

function guessSuppliesForButchery(it) {
  return [
    { name: "butchery plastic / wrap", qty: 1, unit: "roll" },
    { name: "sanitizing solution (butchery)", qty: 1, unit: "ea" },
  ];
}

function guessEquipmentForButchery(it) {
  const eq = ["butcher-knives", "gloves", "apron"];
  const species = (it.species || "").toLowerCase();
  if (species.includes("cow") || species.includes("cattle")) {
    eq.push("hoist / gambrel");
  }
  return eq;
}

function makeSessionTitle(items, policy) {
  if (policy === "butchery-only") return "Animal Butchery Session";
  if (items.some((it) => it.butcherAt)) {
    return "Animal Care + Butchery";
  }
  const pen = items[0]?.pen || "Animal Care";
  return `Animal Care — ${pen}`;
}

// -----------------------------------------------------------------------------
// EVENT / HUB / PERSIST
// -----------------------------------------------------------------------------

function emitEvent(type, data) {
  const payload = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE_ID,
    data,
  };
  if (eventBus && typeof eventBus.emit === "function") {
    eventBus.emit(type, payload);
  } else {
    console.warn("[AnimalSessionEngine] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatAnimalSessionForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // Hub is optional — fail silently
    console.warn("[AnimalSessionEngine] Hub export failed (silent)", e);
  }
}

async function persistSession(session) {
  if (AnimalSessionStore && typeof AnimalSessionStore.save === "function") {
    try {
      await AnimalSessionStore.save(session);
      return session;
    } catch (e) {
      console.warn("[AnimalSessionEngine] persistSession failed, returning in-memory session", e);
      return session;
    }
  }
  return session;
}

// -----------------------------------------------------------------------------
// MISC
// -----------------------------------------------------------------------------

function estimateEndTime(startIso, totalMinutes) {
  const start = new Date(startIso).getTime();
  const end = start + totalMinutes * 60 * 1000;
  return new Date(end).toISOString();
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default AnimalSessionEngine;
