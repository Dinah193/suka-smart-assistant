// C:\Users\larho\suka-smart-assistant\src\domain\garden\GardenSessionEngine.js
// Builds garden work sessions from plans and imported or local seed data selected by user
// -----------------------------------------------------------------------------
// HOW THIS FITS THE SSA PIPELINE
// imports (garden/seed packets, planting guides, pruning videos, storehouse-low triggers,
// animal/forage guides)
//   → ImportService → normalized garden payloads
//   → GardenPlanner.jsx (user chooses zones, crops, dates, succession)
//   → GardenSessionEngine (THIS FILE) turns those plan items OR direct imports into
//       actionable garden WORK SESSIONS, e.g.:
//         - "Sow carrots in Back Beds"
//         - "Transplant tomatoes to Greenhouse / Hoop"
//         - "Water + fertilize orchard / vines"
//         - "Harvest greens (cut-and-come-again)"
//         - "Animal forage bed maintenance"
//   → emits: garden.session.generated, garden.harvest.logged, inventory.updated
//   → automation.runtime can schedule these sessions (respecting sabbath/quiet-hours/weather)
//   → if familyFundMode=true → we also export to Hub
//
// GOALS
// - Forward-thinking: supports domains "garden", "seed", "orchard", "forage", "animal", "storehouse"
// - Event-driven: everything emitted in { type, ts, source, data } ISO format
// - Defensive: all inputs validated
// - Data-changing actions (harvest → inventory) → exportToHubIfEnabled
//
// ASSUMPTIONS
// - src/services/events/eventBus.js
// - src/config/featureFlags.json
// - src/services/hub/HubPacketFormatter.js → formatGardenSessionForHub
// - src/services/hub/FamilyFundConnector.js
// - src/services/garden/GardenSessionStore.js (optional)
// - src/services/garden/ToolAndSupplyMapper.js (optional) → maps tools/supplies to inventory/storehouse
//
// PUBLIC API
//   GardenSessionEngine.generateFromPlan(plan, options?)
//   GardenSessionEngine.generateFromImports(importsArray, options?)
//   GardenSessionEngine.generateSingleSession(gardenItemsArray, options?)
//   GardenSessionEngine.onSessionExecuted(sessionId, actuals)
//

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatGardenSessionForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

// optional deps
let GardenSessionStore = null;
let ToolAndSupplyMapper = null;

try {
  // eslint-disable-next-line global-require
  GardenSessionStore = require("./GardenSessionStore.js");
} catch (e) {
  GardenSessionStore = null;
}

try {
  // eslint-disable-next-line global-require
  ToolAndSupplyMapper = require("../../services/garden/ToolAndSupplyMapper.js");
} catch (e) {
  ToolAndSupplyMapper = null;
}

const SOURCE_ID = "domain.garden.GardenSessionEngine";

const GardenSessionEngine = {
  /**
   * Generate garden sessions from a saved garden plan.
   * @param {Object} plan - { id, items: [{crop, zone, method, startDate, care, harvestWindow, ...}] }
   * @param {Object} options - { policy: "zone-window"|"flat"|"by-start-date", attachSupplies: true }
   * @returns {Promise<Array>}
   */
  async generateFromPlan(plan, options = {}) {
    if (!plan || !Array.isArray(plan.items)) {
      console.warn("[GardenSessionEngine] generateFromPlan: invalid plan");
      return [];
    }

    const policy = options.policy || "zone-window";
    const attachSupplies = options.attachSupplies ?? true;

    // 1. group by policy
    const grouped = groupGardenItems(plan.items, policy);

    const sessions = [];
    for (const group of grouped) {
      const session = await buildGardenSessionFromItems(group, {
        planId: plan.id,
        policy,
        attachSupplies,
      });
      sessions.push(session);
    }

    // 2. persist + emit
    for (const s of sessions) {
      const saved = await persistSession(s);
      const evt = emitEvent("garden.session.generated", { session: saved });
      await exportToHubIfEnabled(evt);
    }

    return sessions;
  },

  /**
   * Reverse generation: user selected imported seed/garden data → generate work session
   * @param {Array} importsArray
   * @param {Object} options
   * @returns {Promise<Array>}
   */
  async generateFromImports(importsArray, options = {}) {
    if (!Array.isArray(importsArray) || !importsArray.length) {
      console.warn("[GardenSessionEngine] generateFromImports: empty imports");
      return [];
    }

    const items = importsArray
      .map((imp) => normalizeImportToGardenItem(imp))
      .filter(Boolean);

    return this.generateSingleSession(items, {
      ...options,
      source: "imports.direct",
    });
  },

  /**
   * Generate just ONE session from a set of garden items (zoned plants)
   * @param {Array} gardenItems
   * @param {Object} options
   * @returns {Promise<Array>} array with 1 session
   */
  async generateSingleSession(gardenItems, options = {}) {
    if (!Array.isArray(gardenItems) || !gardenItems.length) {
      console.warn("[GardenSessionEngine] generateSingleSession: no items");
      return [];
    }

    const session = await buildGardenSessionFromItems(gardenItems, {
      planId: options.planId || null,
      policy: options.policy || "single-zone",
      attachSupplies: options.attachSupplies ?? true,
      source: options.source || "ui.single-session",
    });

    const saved = await persistSession(session);
    const evt = emitEvent("garden.session.generated", { session: saved });
    await exportToHubIfEnabled(evt);

    return [saved];
  },

  /**
   * Called by runtime when the garden session is actually done.
   * This is where we log harvests and update inventory.
   * @param {string} sessionId
   * @param {Object} actuals - e.g. { completedTasks, harvestLogged: [{crop, qty, unit, zone}], suppliesUsed: [...] }
   */
  async onSessionExecuted(sessionId, actuals = {}) {
    let session = null;
    if (
      GardenSessionStore &&
      typeof GardenSessionStore.markExecuted === "function"
    ) {
      session = await GardenSessionStore.markExecuted(sessionId, actuals);
    }

    // 1. emit garden.executed-like event (we'll just re-use garden.harvest.logged for harvests)
    const baseEvt = emitEvent("garden.session.executed", {
      sessionId,
      actuals,
      session,
    });
    await exportToHubIfEnabled(baseEvt);

    // 2. harvest → inventory.updated + garden.harvest.logged
    if (Array.isArray(actuals.harvestLogged) && actuals.harvestLogged.length) {
      const harvestEvt = emitEvent("garden.harvest.logged", {
        sessionId,
        items: actuals.harvestLogged,
      });
      await exportToHubIfEnabled(harvestEvt);

      const invEvt = emitEvent("inventory.updated", {
        sourceSessionId: sessionId,
        deltas: actuals.harvestLogged.map((h) => ({
          item: h.crop,
          qty: h.qty,
          unit: h.unit || "ea",
          direction: "increment",
          zone: h.zone,
        })),
      });
      await exportToHubIfEnabled(invEvt);
    }

    // 3. supplies used → inventory.updated (decrement)
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
  },
};

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

/**
 * Group garden items according to policy.
 * "zone-window": group by zone
 * "by-start-date": group by startDate (day)
 * "flat": everything in one
 */
function groupGardenItems(items, policy) {
  if (!Array.isArray(items) || !items.length) return [];

  if (policy === "flat") {
    return [items];
  }

  if (policy === "by-start-date") {
    const map = {};
    items.forEach((it) => {
      const key = (it.startDate || "").slice(0, 10) || "no-date";
      if (!map[key]) map[key] = [];
      map[key].push(it);
    });
    return Object.values(map);
  }

  // default: zone-window
  const map = {};
  items.forEach((it) => {
    const zone = it.zone || "Unassigned";
    if (!map[zone]) map[zone] = [];
    map[zone].push(it);
  });
  return Object.values(map);
}

/**
 * Build a single garden session from garden items.
 * @param {Array} items
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function buildGardenSessionFromItems(items, ctx = {}) {
  const id = makeId("gardenSess");
  const nowIso = new Date().toISOString();

  // 1. build tasks
  const tasks = buildTasks(items);

  // 2. collect tools/supplies from tasks
  let tools = collectToolsFromTasks(tasks);
  let supplies = collectSuppliesFromTasks(tasks);

  // 3. map tools/supplies to inventory/storehouse
  if (
    ctx.attachSupplies &&
    ToolAndSupplyMapper &&
    typeof ToolAndSupplyMapper.map === "function"
  ) {
    try {
      const mapped = await ToolAndSupplyMapper.map(
        { tools, supplies },
        { allowSubstitutions: true }
      );
      tools = mapped.tools || tools;
      supplies = mapped.supplies || supplies;
    } catch (e) {
      console.warn(
        "[GardenSessionEngine] ToolAndSupplyMapper failed, using raw",
        e
      );
    }
  }

  // 4. estimate duration
  const totalDuration = tasks.reduce(
    (sum, t) => sum + (Number(t.duration) || 10),
    0
  );

  const session = {
    id,
    ts: nowIso,
    domain: "garden",
    source: SOURCE_ID,
    planId: ctx.planId || null,
    title: makeSessionTitle(items, ctx.policy),
    tasks,
    tools,
    supplies,
    schedule: {
      start: nowIso,
      estimatedEnd: estimateEndTime(nowIso, totalDuration),
      policy: ctx.policy || "zone-window",
    },
    meta: buildMeta(items, ctx),
    status: "pending",
  };

  return session;
}

/**
 * Build tasks:
 * - sow / transplant (from method)
 * - care (water, fertilize, prune, trellis) from item.care
 * - harvest tasks from item.harvestWindow
 */
function buildTasks(items) {
  const tasks = [];
  items.forEach((it, idx) => {
    const baseOrder = idx * 10;

    // 1. primary task: sow or transplant
    const primary = {
      id: makeId("gTask"),
      order: baseOrder + 1,
      label: buildPrimaryLabel(it),
      zone: it.zone || "Unassigned",
      duration: it.method === "transplant" ? 15 : 10,
      type: it.method === "transplant" ? "transplant" : "sow",
      crop: it.crop,
      variety: it.variety,
      tags: it.tags || [],
      tools: guessToolsFromItem(it),
      supplies: guessSuppliesFromItem(it),
    };
    tasks.push(primary);

    // 2. care tasks
    (it.care || []).forEach((care, careIdx) => {
      tasks.push({
        id: makeId("gTask"),
        order: baseOrder + 2 + careIdx,
        label: buildCareLabel(it, care),
        zone: it.zone || "Unassigned",
        duration: 6,
        type: "care",
        careType: care.type,
        crop: it.crop,
        tools: guessToolsFromCare(care, it),
        supplies: guessSuppliesFromCare(care, it),
        tags: ["care"],
      });
    });

    // 3. harvest task (optional, creates future session, but we keep in the same bundle)
    if (it.harvestWindow) {
      tasks.push({
        id: makeId("gTask"),
        order: baseOrder + 9,
        label: `Harvest ${it.crop || "crop"}`,
        zone: it.zone || "Unassigned",
        duration: 8,
        type: "harvest",
        crop: it.crop,
        expectedQty: it.harvestWindow.expectedQty || null,
        tags: ["harvest"],
      });
    }
  });
  return tasks;
}

/**
 * Collect unique tools from tasks
 */
function collectToolsFromTasks(tasks) {
  const set = new Set();
  tasks.forEach((t) => {
    (t.tools || []).forEach((tool) => set.add(tool));
  });
  return Array.from(set);
}

/**
 * Collect unique supplies from tasks
 * Merge by name|unit
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
 * Build meta: zones, domains, hasAnimalForage, hasStorehouse, hasOrchard
 */
function buildMeta(items, ctx) {
  const zones = new Set();
  const domains = new Set(["garden"]);
  let hasAnimal = false;
  let hasStorehouse = false;
  let hasOrchard = false;

  items.forEach((it) => {
    if (it.zone) zones.add(it.zone);
    const d = it.domain || "garden";
    domains.add(d);
    if (d === "animal" || d === "forage" || d === "animal-fodder")
      hasAnimal = true;
    if (d === "storehouse") hasStorehouse = true;
    if (d === "orchard") hasOrchard = true;
  });

  return {
    zones: Array.from(zones),
    domains: Array.from(domains),
    hasAnimal,
    hasStorehouse,
    hasOrchard,
    policy: ctx.policy || "zone-window",
  };
}

/**
 * Persist session (if store present)
 */
async function persistSession(session) {
  if (GardenSessionStore && typeof GardenSessionStore.save === "function") {
    try {
      await GardenSessionStore.save(session);
      return session;
    } catch (e) {
      console.warn(
        "[GardenSessionEngine] persistSession failed, returning session only",
        e
      );
      return session;
    }
  }
  return session;
}

// -----------------------------------------------------------------------------
// NORMALIZATION / GUESSING
// -----------------------------------------------------------------------------

function normalizeImportToGardenItem(imp) {
  if (!imp) return null;

  // if already garden-like
  if (imp.crop || imp.title) {
    return {
      id: imp.id || makeId("garden"),
      crop: imp.crop || imp.title,
      variety: imp.variety || "",
      zone: imp.zone || "Unassigned",
      method: imp.method || "direct-sow",
      startDate: imp.startDate || new Date().toISOString(),
      care: imp.care || [],
      harvestWindow: imp.harvestWindow || null,
      sourceId: imp.url || imp.sourceId || null,
      tags: imp.tags || [],
      domain: imp.domain || "garden",
    };
  }

  // fallback
  return {
    id: makeId("garden"),
    crop: imp.name || "Imported Crop",
    variety: "",
    zone: "Unassigned",
    method: "direct-sow",
    startDate: new Date().toISOString(),
    care: [],
    harvestWindow: null,
    sourceId: imp.url || null,
    tags: ["imported"],
    domain: "garden",
  };
}

function buildPrimaryLabel(it) {
  const action = it.method === "transplant" ? "Transplant" : "Sow";
  return `${action} ${it.crop || "crop"} ${
    it.variety ? "(" + it.variety + ")" : ""
  }`;
}

function buildCareLabel(it, care) {
  return `Care: ${care.type} for ${it.crop || "crop"}`;
}

function guessToolsFromItem(it) {
  const zone = (it.zone || "").toLowerCase();
  const method = (it.method || "").toLowerCase();
  const tools = [];
  if (method === "direct-sow") tools.push("trowel");
  if (method === "transplant") tools.push("trowel", "watering-can");
  if (zone.includes("orchard") || zone.includes("vines")) tools.push("pruners");
  if (!tools.length) tools.push("trowel");
  return tools;
}

function guessSuppliesFromItem(it) {
  const supplies = [];
  // seed itself
  supplies.push({ name: `${it.crop || "seed"} seeds`, qty: 1, unit: "pkt" });
  // compost or starter
  if (it.method === "transplant") {
    supplies.push({ name: "compost / transplant mix", qty: 1, unit: "bag" });
  }
  return supplies;
}

function guessToolsFromCare(care, it) {
  if (!care) return [];
  if (care.type === "trellis") return ["trellis", "twine"];
  if (care.type === "prune") return ["pruners"];
  if (care.type === "water") return ["hose / watering-can"];
  if (care.type === "fertilize") return ["fertilizer scoop"];
  return guessToolsFromItem(it);
}

function guessSuppliesFromCare(care, it) {
  if (!care) return [];
  if (care.type === "fertilize")
    return [{ name: "fertilizer", qty: 1, unit: "dose" }];
  if (care.type === "water") return []; // water not tracked
  if (care.type === "trellis")
    return [{ name: "garden twine", qty: 1, unit: "ea" }];
  return guessSuppliesFromItem(it);
}

// -----------------------------------------------------------------------------
// MISC / EVENT / HUB
// -----------------------------------------------------------------------------

function makeSessionTitle(items, policy) {
  if (policy === "flat") return "Garden Work Session";
  if (policy === "by-start-date") {
    const d = (items[0]?.startDate || "").slice(0, 10) || "Garden Session";
    return `Garden — ${d}`;
  }
  const zone = items[0]?.zone || "Garden";
  return `Garden — ${zone}`;
}

function estimateEndTime(startIso, totalMinutes) {
  const start = new Date(startIso).getTime();
  const end = start + totalMinutes * 60 * 1000;
  return new Date(end).toISOString();
}

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
    console.warn("[GardenSessionEngine] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatGardenSessionForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // Hub is optional — fail silently
    console.warn("[GardenSessionEngine] Hub export failed (silent)", e);
  }
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default GardenSessionEngine;
