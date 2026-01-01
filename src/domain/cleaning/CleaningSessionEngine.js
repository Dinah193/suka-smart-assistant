// C:\Users\larho\suka-smart-assistant\src\domain\cleaning\CleaningSessionEngine.js
// Generates zone-based cleaning sessions with techniques, equipment, supplies, etc.
// -----------------------------------------------------------------------------
// HOW THIS FITS THE SSA PIPELINE
// imports (cleaning / declutter / garden/yard / animal-area / storehouse / video-how-to)
//   → ImportService → normalized payloads in the intelligence layer
//   → CleaningPlanner.jsx lets the user assemble a plan by zone/frequency
//   → CleaningSessionEngine (THIS FILE) turns those plan items or direct imports
//       into actionable cleaning sessions:
//         - zone-based (Kitchen, Pantry/Storehouse, Animal/Butchery, Garden/Yard, etc.)
//         - technique-aware (sanitize, degrease, dust, mop, vacuum, declutter)
//         - equipment-aware (mop, vacuum, power-washer, dehumidifier)
//         - supply-aware (cleaner, vinegar, baking soda, bleach, cloths)
//   → emits events to the shared eventBus
//       - cleaning.session.generated
//       - cleaning.executed
//       - inventory.updated (when supplies are consumed)
//   → if familyFundMode=true → exportToHubIfEnabled(payload)
//
// GOALS
// - Forward-thinking: supports future domains (preservation cleanup, animal, storehouse).
// - Automated: can be called by automation.runtime or UI.
// - Defensive: validates inputs, returns early, protects against missing services.
// - Consistent payload shape: { type, ts, source, data } with ISO timestamps.
//
// ASSUMPTIONS
// - src/services/eventBus.js exists
// - src/config/featureFlags.json exists and has "familyFundMode"
// - src/services/HubPacketFormatter.js exports formatCleaningSessionForHub
// - src/services/FamilyFundConnector.js exists
// - src/services/cleaning/CleaningSupplyMapper.js exists (optional)
// - src/services/cleaning/CleaningSessionStore.js exists (optional)
//
// PUBLIC API
//   CleaningSessionEngine.generateFromPlan(plan, options?)
//   CleaningSessionEngine.generateFromImports(imports, options?)
//   CleaningSessionEngine.generateSingleSession(tasks, options?)
//   CleaningSessionEngine.onSessionExecuted(sessionId, actuals)
//

import eventBus from "../../services/eventBus";
import featureFlags from "../../config/featureFlags.json";
import { formatCleaningSessionForHub } from "../../services/HubPacketFormatter";
import FamilyFundConnector from "../../services/FamilyFundConnector";

let CleaningSessionStore = null;
let CleaningSupplyMapper = null;

try {
  // optional persistence
  // eslint-disable-next-line global-require
  CleaningSessionStore = require("./CleaningSessionStore.js");
} catch (e) {
  CleaningSessionStore = null;
}

try {
  // optional: maps zone+technique → supplies from inventory/storehouse
  // eslint-disable-next-line global-require
  CleaningSupplyMapper = require("../../services/cleaning/CleaningSupplyMapper.js");
} catch (e) {
  CleaningSupplyMapper = null;
}

const SOURCE_ID = "domain.cleaning.CleaningSessionEngine";

const CleaningSessionEngine = {
  /**
   * Generate cleaning sessions from a saved cleaning plan
   * @param {Object} plan - { id, items: [{title, zone, frequency, duration, tags, domain}] }
   * @param {Object} options - { policy: "zones-first"|"flat"|"by-frequency", attachSupplies: true }
   * @returns {Promise<Array>} list of generated sessions
   */
  async generateFromPlan(plan, options = {}) {
    if (!plan || !Array.isArray(plan.items)) {
      console.warn("[CleaningSessionEngine] generateFromPlan: invalid plan");
      return [];
    }

    const policy = options.policy || "zones-first";
    const attachSupplies = options.attachSupplies ?? true;

    // 1. Group tasks according to policy
    const grouped = groupCleaningTasks(plan.items, policy);

    const sessions = [];
    for (const group of grouped) {
      const session = await buildCleaningSessionFromTasks(group, {
        planId: plan.id,
        policy,
        attachSupplies,
      });
      sessions.push(session);
    }

    // 2. Persist + emit
    for (const s of sessions) {
      const saved = await persistSession(s);
      const evt = emitEvent("cleaning.session.generated", { session: saved });
      await exportToHubIfEnabled(evt);
    }

    return sessions;
  },

  /**
   * Reverse generation: user selected imports (e.g. a TikTok cleaning routine,
   * a Pinterest declutter challenge, a YouTube "deep clean fridge") and wants
   * to run it as an SSA session.
   * @param {Array} importsArray
   * @param {Object} options
   * @returns {Promise<Array>}
   */
  async generateFromImports(importsArray, options = {}) {
    if (!Array.isArray(importsArray) || !importsArray.length) {
      console.warn("[CleaningSessionEngine] generateFromImports: empty imports");
      return [];
    }

    const tasks = importsArray
      .map((imp) => normalizeImportToCleaningTask(imp))
      .filter(Boolean);

    return this.generateSingleSession(tasks, {
      ...options,
      source: "imports.direct",
    });
  },

  /**
   * Generate ONE cleaning session from tasks
   * @param {Array} tasks
   * @param {Object} options
   * @returns {Promise<Array>} array with 1 session
   */
  async generateSingleSession(tasks, options = {}) {
    if (!Array.isArray(tasks) || !tasks.length) {
      console.warn("[CleaningSessionEngine] generateSingleSession: no tasks");
      return [];
    }

    const session = await buildCleaningSessionFromTasks(tasks, {
      planId: options.planId || null,
      policy: options.policy || "single-zone",
      attachSupplies: options.attachSupplies ?? true,
      source: options.source || "ui.single-session",
    });

    const saved = await persistSession(session);
    const evt = emitEvent("cleaning.session.generated", { session: saved });
    await exportToHubIfEnabled(evt);

    return [saved];
  },

  /**
   * Called by runtime when the session is actually completed / marked done.
   * This is where we:
   *  - emit cleaning.executed
   *  - optionally emit inventory.updated (if supplies were used)
   *  - optionally export to Hub
   */
  async onSessionExecuted(sessionId, actuals = {}) {
    let session = null;
    if (CleaningSessionStore && typeof CleaningSessionStore.markExecuted === "function") {
      session = await CleaningSessionStore.markExecuted(sessionId, actuals);
    }

    const evt = emitEvent("cleaning.executed", {
      sessionId,
      actuals,
      session,
    });

    // if actuals.suppliesUsed → inventory.updated
    if (Array.isArray(actuals.suppliesUsed) && actuals.suppliesUsed.length) {
      const invEvt = emitEvent("inventory.updated", {
        sourceSessionId: sessionId,
        deltas: actuals.suppliesUsed.map((sup) => ({
          item: sup.inventoryLink || sup.name,
          qty: sup.qty,
          unit: sup.unit || "ea",
          direction: "decrement",
        })),
      });
      await exportToHubIfEnabled(invEvt);
    }

    await exportToHubIfEnabled(evt);
  },
};

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

/**
 * Group cleaning tasks according to policy.
 * "zones-first" (default): group by zone
 * "by-frequency": group daily, weekly, monthly
 * "flat": everything in 1 session
 */
function groupCleaningTasks(tasks, policy) {
  if (!Array.isArray(tasks) || !tasks.length) return [];

  if (policy === "flat") {
    return [tasks];
  }

  if (policy === "by-frequency") {
    const map = {};
    tasks.forEach((t) => {
      const freq = t.frequency || "once";
      if (!map[freq]) map[freq] = [];
      map[freq].push(t);
    });
    return Object.values(map);
  }

  // default: zones-first
  const map = {};
  tasks.forEach((t) => {
    const zone = t.zone || "Unassigned";
    if (!map[zone]) map[zone] = [];
    map[zone].push(t);
  });
  return Object.values(map);
}

/**
 * Build a session object from an array of cleaning tasks
 * @param {Array} tasks
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function buildCleaningSessionFromTasks(tasks, ctx = {}) {
  const id = makeId("cleanSess");
  const nowIso = new Date().toISOString();

  // 1. Consolidate supplies needed
  let supplies = consolidateSupplies(tasks);

  // 2. Map supplies to inventory/storehouse if mapper present
  if (ctx.attachSupplies && CleaningSupplyMapper && typeof CleaningSupplyMapper.map === "function") {
    try {
      supplies = await CleaningSupplyMapper.map(supplies, {
        allowSubstitutions: true,
        domains: ["storehouse", "inventory"],
      });
    } catch (e) {
      console.warn("[CleaningSessionEngine] supply mapper failed, using raw supplies", e);
    }
  }

  // 3. Build session-level techniques and equipment
  const techniques = buildTechniques(tasks);
  const equipment = buildEquipment(tasks);

  // 4. Estimate total duration
  const totalDuration = tasks.reduce(
    (sum, t) => sum + (Number(t.duration) || 10),
    0
  );

  const session = {
    id,
    ts: nowIso,
    domain: "cleaning",
    source: SOURCE_ID,
    planId: ctx.planId || null,
    title: makeSessionTitle(tasks, ctx.policy),
    tasks: tasks.map((t, idx) => ({
      id: t.id || makeId("cleanTask"),
      order: idx + 1,
      label: t.title,
      zone: t.zone || "Unassigned",
      frequency: t.frequency || "once",
      duration: t.duration || 10,
      technique: t.technique || guessTechniqueFromTags(t.tags),
      equipment: t.equipment || [],
      supplies: t.supplies || [],
      tags: t.tags || [],
      domain: t.domain || "cleaning",
      sourceId: t.sourceId || null,
    })),
    supplies,
    techniques,
    equipment,
    schedule: {
      start: nowIso,
      estimatedEnd: estimateEndTime(nowIso, totalDuration),
      policy: ctx.policy || "zones-first",
    },
    meta: buildMeta(tasks, ctx),
    status: "pending",
  };

  return session;
}

/**
 * Consolidate supplies: merge by name+unit
 */
function consolidateSupplies(tasks) {
  const map = {};
  tasks.forEach((t) => {
    (t.supplies || guessSuppliesFromTask(t)).forEach((sup) => {
      const key = (sup.name || "").toLowerCase() + "|" + (sup.unit || "");
      if (!map[key]) {
        map[key] = {
          name: sup.name,
          qty: Number(sup.qty) || 1,
          unit: sup.unit || "ea",
          taskRefs: [t.title],
        };
      } else {
        map[key].qty += Number(sup.qty) || 1;
        map[key].taskRefs.push(t.title);
      }
    });
  });
  return Object.values(map);
}

/**
 * Build techniques list from tasks
 */
function buildTechniques(tasks) {
  const set = new Set();
  tasks.forEach((t) => {
    if (t.technique) {
      set.add(t.technique);
    } else {
      const guessed = guessTechniqueFromTags(t.tags);
      if (guessed) set.add(guessed);
    }
  });
  return Array.from(set);
}

/**
 * Build equipment list from tasks
 */
function buildEquipment(tasks) {
  const set = new Set();
  tasks.forEach((t) => {
    (t.equipment || guessEquipmentFromTask(t)).forEach((eq) => set.add(eq));
  });
  return Array.from(set);
}

/**
 * Estimate end time from total minutes
 */
function estimateEndTime(startIso, totalMinutes) {
  const start = new Date(startIso).getTime();
  const end = start + totalMinutes * 60 * 1000;
  return new Date(end).toISOString();
}

/**
 * Construct a nice title for the session
 */
function makeSessionTitle(tasks, policy) {
  if (policy === "flat") {
    return "Whole-House Clean";
  }
  if (policy === "by-frequency") {
    const freq = tasks[0]?.frequency || "once";
    return `Cleaning — ${freq}`;
  }
  // zones-first or single-zone
  const zone = tasks[0]?.zone || "Cleaning Session";
  return `Cleaning — ${zone}`;
}

/**
 * Build meta for analytics: zones, domains, hasAnimal, hasStorehouse, hasPreservation
 */
function buildMeta(tasks, ctx) {
  const zones = new Set();
  const domains = new Set(["cleaning"]);
  let hasAnimal = false;
  let hasStorehouse = false;
  let hasPreservation = false;
  let hasGarden = false;

  tasks.forEach((t) => {
    if (t.zone) zones.add(t.zone);
    const d = t.domain || "cleaning";
    domains.add(d);
    if (d === "animal") hasAnimal = true;
    if (d === "storehouse") hasStorehouse = true;
    if (d === "preservation") hasPreservation = true;
    if (d === "garden") hasGarden = true;
  });

  return {
    zones: Array.from(zones),
    domains: Array.from(domains),
    hasAnimal,
    hasStorehouse,
    hasPreservation,
    hasGarden,
    policy: ctx.policy || "zones-first",
  };
}

/**
 * Persist session if store available
 */
async function persistSession(session) {
  if (CleaningSessionStore && typeof CleaningSessionStore.save === "function") {
    try {
      await CleaningSessionStore.save(session);
      return session;
    } catch (e) {
      console.warn("[CleaningSessionEngine] persistSession failed, returning session only", e);
      return session;
    }
  }
  return session;
}

// -----------------------------------------------------------------------------
// NORMALIZATION + GUESSES
// -----------------------------------------------------------------------------

/**
 * Normalize general import to cleaning task
 */
function normalizeImportToCleaningTask(imp) {
  if (!imp) return null;
  // if the import is already normalized for cleaning
  if (imp.title && (imp.zone || imp.technique || imp.tags)) {
    return {
      id: imp.id || makeId("cleanTask"),
      title: imp.title,
      zone: imp.zone || "Unassigned",
      frequency: imp.frequency || "once",
      duration: imp.duration || 10,
      technique: imp.technique || guessTechniqueFromTags(imp.tags),
      equipment: imp.equipment || guessEquipmentFromTask(imp),
      supplies: imp.supplies || guessSuppliesFromTask(imp),
      tags: imp.tags || [],
      domain: imp.domain || "cleaning",
      sourceId: imp.url || imp.sourceId || null,
    };
  }

  // fallback
  return {
    id: makeId("cleanTask"),
    title: imp.name || "Imported Cleaning Task",
    zone: "Unassigned",
    frequency: "once",
    duration: 10,
    technique: guessTechniqueFromTags(imp.tags),
    equipment: guessEquipmentFromTask(imp),
    supplies: guessSuppliesFromTask(imp),
    tags: imp.tags || [],
    domain: "cleaning",
    sourceId: imp.url || null,
  };
}

/**
 * Guess technique from tags
 */
function guessTechniqueFromTags(tags = []) {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.includes("sanitize")) return "sanitize";
  if (lower.includes("degrease")) return "degrease";
  if (lower.includes("dust")) return "dust";
  if (lower.includes("mop")) return "mop";
  if (lower.includes("vacuum")) return "vacuum";
  if (lower.includes("declutter")) return "declutter";
  return "general-clean";
}

/**
 * Guess equipment based on zone/title
 */
function guessEquipmentFromTask(task = {}) {
  const zone = (task.zone || "").toLowerCase();
  const title = (task.title || "").toLowerCase();
  const eq = [];

  if (zone.includes("bathroom")) eq.push("bathroom-brush");
  if (zone.includes("kitchen")) eq.push("microfiber-cloth");
  if (zone.includes("pantry") || zone.includes("storehouse")) eq.push("shop-vac");
  if (title.includes("mop") || zone.includes("utility")) eq.push("mop");
  if (title.includes("vacuum")) eq.push("vacuum");
  return eq.length ? eq : ["microfiber-cloth"];
}

/**
 * Guess supplies based on technique/zone
 */
function guessSuppliesFromTask(task = {}) {
  const sup = [];
  const technique = task.technique || guessTechniqueFromTags(task.tags || []);
  const zone = task.zone || "";

  if (technique === "sanitize") {
    sup.push({ name: "multi-surface cleaner", qty: 1, unit: "ea" });
    sup.push({ name: "disinfectant", qty: 1, unit: "ea" });
  } else if (technique === "degrease") {
    sup.push({ name: "degreaser", qty: 1, unit: "ea" });
  } else if (technique === "vacuum") {
    sup.push({ name: "vacuum bag / canister", qty: 1, unit: "ea" });
  } else {
    sup.push({ name: "all-purpose cleaner", qty: 1, unit: "ea" });
  }

  if (zone.toLowerCase().includes("animal")) {
    sup.push({ name: "sanitizing solution (animal-safe)", qty: 1, unit: "ea" });
  }

  return sup;
}

// -----------------------------------------------------------------------------
// EVENT + HUB HELPERS
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
    console.warn("[CleaningSessionEngine] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatCleaningSessionForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // Hub is optional — fail silently
    console.warn("[CleaningSessionEngine] Hub export failed (silent)", e);
  }
}

// -----------------------------------------------------------------------------
// MISC
// -----------------------------------------------------------------------------

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default CleaningSessionEngine;
