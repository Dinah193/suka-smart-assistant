// C:\Users\larho\suka-smart-assistant\src\features\animal\AnimalPlanner.logic.js
// -----------------------------------------------------------------------------
// AnimalPlanner.logic
//
// How this fits the SSA system:
// - Pure logic module for the Animal Planner feature.
// - Connects animal acquisition/breeding/usage plans to:
//     • feed demand,
//     • butchery schedule & yields,
//     • (high-level) micronutrient coverage,
//     • SessionRunner-friendly session objects.
// - It DOES NOT touch UI directly. Instead it:
//     • builds derived planning data (feed, butcher, nutrition),
//     • builds Session objects matching the shared Session contract,
//     • emits eventBus events so the rest of SSA can react,
//     • optionally syncs sessions via a pluggable persistence adapter.
//
// Contracts used from the Master Codegen Prompt:
// - Session object contract (minimum viable):
//   {
//     id: string,
//     domain: "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse",
//     title: string,
//     source: { type: "recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual", refId: string|null },
//     steps: [
//       {
//         id: string,
//         title: string,
//         desc: string,
//         durationSec: number,
//         blockers: ("inventory"|"weather"|"quietHours"|"sabbath"|"equipment")[],
//         metadata: {
//           tempTargetF: number,
//           donenessCue: "color"|"texture"|"probeTemp"|"timer"|"smell",
//           cueNotes: string
//         }
//       }
//     ],
//     prefs: { voiceGuidance: boolean, haptic: boolean, autoAdvance: boolean },
//     status: "pending"|"running"|"paused"|"completed"|"aborted",
//     progress: { currentStepIndex: number, elapsedSec: number, startedAt: string|null, pausedAt: string|null },
//     analytics: { skippedSteps: string[], adjustments: any[] },
//     createdAt: string,
//     updatedAt: string
//   }
//
// - Event bus: emitEvent({ type, ts, source, data })
//   Session events (emitted by SessionRunner, not here):
//   session.started, session.step.changed, session.paused, session.resumed,
//   session.completed, session.aborted, session.exported.
//
// This module emits:
//
//   animal.plan.updated
//   animal.plan.sessionsGenerated
//
// (The SessionRunner will later emit the session.* lifecycle events.)
//
// -----------------------------------------------------------------------------
// NOTE ON PERSISTENCE
// -----------------------------------------------------------------------------
// To avoid hard-coding Dexie paths and breaking your build, this module uses a
// pluggable "SessionPersistenceAdapter":
//
//   const adapter = {
//     saveSessionsBatch: async (sessions) => { ... },
//     saveSession: async (session) => { ... } // optional, not used in batch path
//   };
//
// You can wire this adapter to your Dexie sessions table in a separate file
// (e.g. src/services/sessionsAdapter.js) and pass it into
// `syncAnimalPlanToSessions(...)`.
// -----------------------------------------------------------------------------

import { emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

/**
 * @typedef {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} SessionDomain
 */

/**
 * @typedef {"recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual"} SessionSourceType
 */

/**
 * @typedef {"inventory"|"weather"|"quietHours"|"sabbath"|"equipment"} SessionBlocker
 */

/**
 * @typedef {"color"|"texture"|"probeTemp"|"timer"|"smell"} DonenessCue
 */

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {SessionBlocker[]} blockers
 * @property {{ tempTargetF: number, donenessCue: DonenessCue, cueNotes: string }} metadata
 */

/**
 * @typedef {Object} SessionProgress
 * @property {number} currentStepIndex
 * @property {number} elapsedSec
 * @property {string|null} startedAt
 * @property {string|null} pausedAt
 */

/**
 * @typedef {Object} SessionAnalytics
 * @property {string[]} skippedSteps
 * @property {any[]} adjustments
 */

/**
 * @typedef {Object} SessionSource
 * @property {SessionSourceType} type
 * @property {string|null} refId
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {SessionDomain} domain
 * @property {string} title
 * @property {SessionSource} source
 * @property {SessionStep[]} steps
 * @property {{ voiceGuidance: boolean, haptic: boolean, autoAdvance: boolean }} prefs
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {SessionProgress} progress
 * @property {SessionAnalytics} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} AnimalUnit
 * @property {string} id                  Unique animal type ID (e.g. "lamb-meat", "laying-hen", "dairy-goat")
 * @property {string} species             Human label: "sheep", "goat", "chicken", "duck", "cow", etc.
 * @property {"meat"|"egg"|"milk"|"fiber"|"work"|"mixed"} role
 * @property {number} count               Number of this unit in the plan
 * @property {string} lifecycleStage      e.g. "starter", "grower", "breeder", "layer", "dry-period"
 * @property {number} startDay            Day index (0-based) when this unit enters the system
 * @property {number} endDay              Day index when this unit leaves or is butchered
 * @property {number} [targetWeightKg]    Optional butcher weight for meat animals
 * @property {number} [avgDailyGainKg]    Optional daily gain for growth modeling
 */

/**
 * @typedef {Object} AnimalPlan
 * @property {string} id                      Unique plan ID
 * @property {string} label                   Short human label, e.g. "2025 Meat & Eggs"
 * @property {string} season                  Label like "Spring 2025", "Year 1"
 * @property {number} horizonDays             Planning horizon in days (window this plan covers)
 * @property {AnimalUnit[]} animals           Flattened list of animal units in this plan
 * @property {Object<string, any>} [meta]     Arbitrary metadata (notes, tags, etc.)
 */

/**
 * @typedef {Object} FeedProfile
 * @property {string} animalId                Must match AnimalUnit.id
 * @property {number} dryMatterLbPerDay       Approx lbs/day dry matter feed
 * @property {number} pastureFraction         0–1 fraction from pasture/forage
 * @property {number} purchasedFraction       0–1 fraction from purchased feed
 */

/**
 * @typedef {Object} YieldProfile
 * @property {string} animalId                Must match AnimalUnit.id
 * @property {number} meatLb                  Carcass meat (edible cuts) per animal
 * @property {number} bonesLb                 Bones per animal
 * @property {number} organsLb                Organs/offal per animal
 * @property {number} fatLb                   Renderable fat per animal
 * @property {number} [eggsPerYear]           For layers (optional)
 * @property {number} [milkGalPerYear]        For dairy (optional)
 * @property {number} [fiberLbPerYear]        For fiber animals (optional)
 */

/**
 * @typedef {Object} MicronutrientProfile
 * @property {string} foodId                  e.g. "lamb-meat", "chicken-egg", "goat-milk"
 * @property {number} caloriesPerLb
 * @property {number} proteinGPerLb
 * @property {number} ironMgPerLb
 * @property {number} zincMgPerLb
 * @property {number} b12McgPerLb
 * // Add more as needed later
 */

/**
 * @typedef {Object} FeedDemandPoint
 * @property {number} dayIndex
 * @property {number} totalDryMatterLb
 * @property {number} pastureLb
 * @property {number} purchasedLb
 * @property {Object<string, number>} byAnimalId
 */

/**
 * @typedef {Object} ButcheryEvent
 * @property {string} animalId
 * @property {string} animalLabel
 * @property {number} dayIndex
 * @property {number} count
 * @property {YieldProfile} yieldPerAnimal
 * @property {Object<string, number>} totals   // { meatLb, bonesLb, organsLb, fatLb }
 */

/**
 * @typedef {Object} MicronutrientCoverage
 * @property {number} totalCalories
 * @property {number} totalProteinG
 * @property {number} totalIronMg
 * @property {number} totalZincMg
 * @property {number} totalB12Mcg
 * @property {Object<string, number>} byFoodId
 */

/**
 * @typedef {Object} SessionPersistenceAdapter
 * @property {(session: Session) => Promise<void>} [saveSession]
 * @property {(sessions: Session[]) => Promise<void>} saveSessionsBatch
 */

// -----------------------------------------------------------------------------
// Small internal helpers
// -----------------------------------------------------------------------------

/**
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Very lightweight unique ID generator.
 * You can swap this out later for nanoid/uuid if desired.
 * @param {string} prefix
 * @returns {string}
 */
function makeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/**
 * @param {any} n
 * @param {number} fallback
 * @returns {number}
 */
function toNumberOr(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Clamp between min and max.
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// -----------------------------------------------------------------------------
// Core: Build derived planning data from AnimalPlan
// -----------------------------------------------------------------------------

/**
 * Build a simple "graph-like" representation of the animal plan.
 * This keeps the door open for later Planning Graph visualization.
 *
 * @param {AnimalPlan} plan
 * @returns {{
 *   planId: string,
 *   nodes: { id: string, type: string, ref: AnimalUnit }[],
 *   edges: { from: string, to: string, relation: string }[]
 * }}
 */
export function buildAnimalPlanGraph(plan) {
  if (!plan || !Array.isArray(plan.animals)) {
    return { planId: plan?.id || "unknown", nodes: [], edges: [] };
  }

  const nodes = plan.animals.map((unit) => ({
    id: unit.id,
    type: `animal-${unit.role}`,
    ref: unit,
  }));

  // For now: edges based on lifecycle stage, simple "sequence" by startDay.
  const sorted = [...plan.animals].sort((a, b) => a.startDay - b.startDay);
  const edges = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    edges.push({
      from: sorted[i].id,
      to: sorted[i + 1].id,
      relation: "time-sequence",
    });
  }

  // Emit a soft event so any Planning Graph visualizer can react.
  emitSafe("animal.plan.updated", {
    planId: plan.id,
    season: plan.season,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });

  return { planId: plan.id, nodes, edges };
}

/**
 * Calculates daily feed demand for the planning horizon.
 *
 * @param {AnimalPlan} plan
 * @param {FeedProfile[]} feedProfiles
 * @returns {FeedDemandPoint[]}
 */
export function calculateFeedDemand(plan, feedProfiles) {
  if (!plan || !Array.isArray(plan.animals) || !Array.isArray(feedProfiles)) {
    return [];
  }

  const horizon = toNumberOr(plan.horizonDays, 0);
  if (horizon <= 0) return [];

  /** @type {Map<string, FeedProfile>} */
  const profileById = new Map();
  feedProfiles.forEach((fp) => {
    if (fp && fp.animalId) {
      profileById.set(fp.animalId, fp);
    }
  });

  /** @type {FeedDemandPoint[]} */
  const results = [];

  for (let dayIndex = 0; dayIndex < horizon; dayIndex += 1) {
    /** @type {Object<string, number>} */
    const byAnimalId = {};
    let totalDryMatterLb = 0;
    let pastureLb = 0;
    let purchasedLb = 0;

    plan.animals.forEach((unit) => {
      if (dayIndex < unit.startDay || dayIndex > unit.endDay) return;

      const profile = profileById.get(unit.id);
      if (!profile) return;

      const perAnimal = toNumberOr(profile.dryMatterLbPerDay, 0);
      const count = toNumberOr(unit.count, 0);
      const unitTotal = perAnimal * count;

      if (!Number.isFinite(unitTotal) || unitTotal <= 0) return;

      byAnimalId[unit.id] = (byAnimalId[unit.id] || 0) + unitTotal;
      totalDryMatterLb += unitTotal;

      const pastureFrac = clamp(profile.pastureFraction ?? 0, 0, 1);
      const purchasedFrac = clamp(profile.purchasedFraction ?? 0, 0, 1);
      const norm = pastureFrac + purchasedFrac || 1;
      const pPasture = (pastureFrac / norm) * unitTotal;
      const pPurchased = (purchasedFrac / norm) * unitTotal;

      pastureLb += pPasture;
      purchasedLb += pPurchased;
    });

    results.push({
      dayIndex,
      totalDryMatterLb,
      pastureLb,
      purchasedLb,
      byAnimalId,
    });
  }

  return results;
}

/**
 * Build a butchery schedule and expected yields based on AnimalPlan and yield profiles.
 *
 * @param {AnimalPlan} plan
 * @param {YieldProfile[]} yieldProfiles
 * @returns {ButcheryEvent[]}
 */
export function estimateButcherySchedule(plan, yieldProfiles) {
  if (!plan || !Array.isArray(plan.animals) || !Array.isArray(yieldProfiles)) {
    return [];
  }

  /** @type {Map<string, YieldProfile>} */
  const yieldById = new Map();
  yieldProfiles.forEach((yp) => {
    if (yp && yp.animalId) {
      yieldById.set(yp.animalId, yp);
    }
  });

  /** @type {ButcheryEvent[]} */
  const events = [];

  plan.animals.forEach((unit) => {
    // We treat `endDay` as the likely butcher/exit window for meat animals.
    if (unit.role !== "meat" && unit.role !== "mixed") return;
    const yp = yieldById.get(unit.id);
    if (!yp) return;

    const count = toNumberOr(unit.count, 0);
    if (count <= 0) return;

    const totals = {
      meatLb: toNumberOr(yp.meatLb, 0) * count,
      bonesLb: toNumberOr(yp.bonesLb, 0) * count,
      organsLb: toNumberOr(yp.organsLb, 0) * count,
      fatLb: toNumberOr(yp.fatLb, 0) * count,
    };

    events.push({
      animalId: unit.id,
      animalLabel: `${unit.species} (${unit.lifecycleStage})`,
      dayIndex: unit.endDay,
      count,
      yieldPerAnimal: yp,
      totals,
    });
  });

  return events;
}

/**
 * Aggregate micronutrient coverage from butchery outputs.
 * This is intentionally coarse; it’s designed for integration with your
 * detailed micronutrient calculators later.
 *
 * @param {ButcheryEvent[]} events
 * @param {MicronutrientProfile[]} micronutrientProfiles
 * @returns {MicronutrientCoverage}
 */
export function mapButcheryToMicronutrients(events, micronutrientProfiles) {
  /** @type {Map<string, MicronutrientProfile>} */
  const profileByFood = new Map();
  micronutrientProfiles.forEach((mp) => {
    if (mp && mp.foodId) profileByFood.set(mp.foodId, mp);
  });

  let totalCalories = 0;
  let totalProteinG = 0;
  let totalIronMg = 0;
  let totalZincMg = 0;
  let totalB12Mcg = 0;
  /** @type {Object<string, number>} */
  const byFoodId = {};

  events.forEach((ev) => {
    const foodId = ev.animalId; // simple assumption: yield foodId == animalId
    const profile = profileByFood.get(foodId);
    if (!profile) return;

    const meatLb = ev.totals.meatLb || 0;
    if (meatLb <= 0) return;

    const cals = profile.caloriesPerLb * meatLb;
    const protein = profile.proteinGPerLb * meatLb;
    const iron = profile.ironMgPerLb * meatLb;
    const zinc = profile.zincMgPerLb * meatLb;
    const b12 = profile.b12McgPerLb * meatLb;

    totalCalories += cals;
    totalProteinG += protein;
    totalIronMg += iron;
    totalZincMg += zinc;
    totalB12Mcg += b12;

    byFoodId[foodId] = (byFoodId[foodId] || 0) + meatLb;
  });

  return {
    totalCalories,
    totalProteinG,
    totalIronMg,
    totalZincMg,
    totalB12Mcg,
    byFoodId,
  };
}

// -----------------------------------------------------------------------------
// Session generation: Turn AnimalPlan into SessionRunner-ready sessions
// -----------------------------------------------------------------------------

/**
 * Build a single Session object in the "animals" domain.
 *
 * @param {Object} opt
 * @param {string} opt.planId
 * @param {string} opt.planLabel
 * @param {string} opt.flowKey
 * @param {string} opt.title
 * @param {string} opt.desc
 * @param {string[]} opt.stepTitles
 * @param {number} opt.defaultDurationSec
 * @returns {Session}
 */
function buildAnimalSession({
  planId,
  planLabel,
  flowKey,
  title,
  desc,
  stepTitles,
  defaultDurationSec,
}) {
  const id = makeId(`animals_${flowKey}`);
  const createdAt = nowIso();

  /** @type {SessionStep[]} */
  const steps = stepTitles.map((st) => ({
    id: makeId(`step_${flowKey}`),
    title: st,
    desc: `${st} for plan "${planLabel}"`,
    durationSec: defaultDurationSec,
    blockers: /** @type {SessionBlocker[]} */ (["inventory", "quietHours"]),
    metadata: {
      tempTargetF: 0,
      donenessCue: /** @type {DonenessCue} */ ("timer"),
      cueNotes: "Timing-based planning step; no temperature target.",
    },
  }));

  /** @type {Session} */
  const session = {
    id,
    domain: /** @type {SessionDomain} */ ("animals"),
    title,
    source: {
      type: /** @type {SessionSourceType} */ ("animalTask"),
      refId: planId || null,
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      skippedSteps: [],
      adjustments: [],
    },
    createdAt,
    updatedAt: createdAt,
  };

  return session;
}

/**
 * Generate a set of Sessions for the SessionRunner from an AnimalPlan.
 * This does NOT persist them; use syncAnimalPlanToSessions for that.
 *
 * @param {AnimalPlan} plan
 * @returns {Session[]}
 */
export function generateAnimalSessionsFromPlan(plan) {
  if (!plan || !Array.isArray(plan.animals) || plan.animals.length === 0) {
    return [];
  }

  const label = plan.label || "Animal Plan";
  const sessions = [];

  // Session 1: Acquisition & On-Ramp
  sessions.push(
    buildAnimalSession({
      planId: plan.id,
      planLabel: label,
      flowKey: "acquisition",
      title: `Animal Acquisition for ${label}`,
      desc: "Clarify the what, why, and when of incoming animals.",
      stepTitles: [
        "Confirm species and breeds",
        "Confirm maximum head count and land capacity",
        "Verify housing, fencing, and starter feed",
        "Schedule arrival dates and quarantine spaces",
      ],
      defaultDurationSec: 7 * 60,
    })
  );

  // Session 2: Breeding Calendar
  sessions.push(
    buildAnimalSession({
      planId: plan.id,
      planLabel: label,
      flowKey: "breeding",
      title: `Breeding Calendar for ${label}`,
      desc: "Plan breeding windows, birth windows, and replacements.",
      stepTitles: [
        "Choose breeding windows for each species",
        "Align births with pasture/forage peaks",
        "Define keeper rules for replacements",
        "Mark likely cull candidates early",
      ],
      defaultDurationSec: 10 * 60,
    })
  );

  // Session 3: Usage & Flow
  sessions.push(
    buildAnimalSession({
      planId: plan.id,
      planLabel: label,
      flowKey: "usage",
      title: `Usage Flow for ${label}`,
      desc: "Connect animals to meals, milk/eggs, fiber, and storehouse.",
      stepTitles: [
        "Map meat animals to butcher and preservation windows",
        "Map egg and milk yield into weekly meal plans",
        "Plan fiber harvest and storage",
        "Verify exit plans for surplus or problem animals",
      ],
      defaultDurationSec: 12 * 60,
    })
  );

  // Session 4: Risk & Resilience
  sessions.push(
    buildAnimalSession({
      planId: plan.id,
      planLabel: label,
      flowKey: "risk",
      title: `Risk & Resilience for ${label}`,
      desc: "Plan for feed shocks, disease, and sudden downsizing.",
      stepTitles: [
        "Define minimum and maximum animal counts per species",
        "List animals to sell or butcher first under feed pressure",
        "Review isolation and quarantine spaces",
        "Capture vet contact info and basic emergency steps",
      ],
      defaultDurationSec: 8 * 60,
    })
  );

  // Emit a soft event so other parts of SSA can react
  emitSafe("animal.plan.sessionsGenerated", {
    planId: plan.id,
    sessionCount: sessions.length,
    season: plan.season,
  });

  return sessions;
}

/**
 * Persist sessions and emit integration-friendly events so the SessionRunner
 * knows new animal-related planning sessions exist.
 *
 * @param {Object} opt
 * @param {AnimalPlan} opt.plan
 * @param {SessionPersistenceAdapter} opt.adapter
 * @param {boolean} [opt.emitEvents=true]
 * @returns {Promise<{planId: string, sessionIds: string[]}>}
 */
export async function syncAnimalPlanToSessions({ plan, adapter, emitEvents = true }) {
  if (!plan || !adapter || typeof adapter.saveSessionsBatch !== "function") {
    throw new Error(
      "[AnimalPlanner.logic] syncAnimalPlanToSessions requires a plan and an adapter with saveSessionsBatch"
    );
  }

  const sessions = generateAnimalSessionsFromPlan(plan);
  if (sessions.length === 0) {
    return { planId: plan?.id || "unknown", sessionIds: [] };
  }

  await adapter.saveSessionsBatch(sessions);

  const sessionIds = sessions.map((s) => s.id);

  if (emitEvents) {
    emitSafe("animal.plan.sessionsSynced", {
      planId: plan.id,
      sessionIds,
      season: plan.season,
      familyFundMode,
    });
  }

  return { planId: plan.id, sessionIds };
}

// -----------------------------------------------------------------------------
// Safe event wrapper
// -----------------------------------------------------------------------------

/**
 * Helper to emit events defensively to the event bus.
 *
 * @param {string} type
 * @param {any} data
 */
function emitSafe(type, data) {
  try {
    emitEvent({
      type,
      ts: nowIso(),
      source: "AnimalPlanner.logic",
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[AnimalPlanner.logic] Failed to emit ${type}`, err);
  }
}

// -----------------------------------------------------------------------------
// Default export (optional convenience)
// -----------------------------------------------------------------------------

const AnimalPlannerLogic = {
  buildAnimalPlanGraph,
  calculateFeedDemand,
  estimateButcherySchedule,
  mapButcheryToMicronutrients,
  generateAnimalSessionsFromPlan,
  syncAnimalPlanToSessions,
};

export default AnimalPlannerLogic;
