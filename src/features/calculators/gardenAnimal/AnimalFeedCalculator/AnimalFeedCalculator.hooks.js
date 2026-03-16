// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\AnimalFeedCalculator\AnimalFeedCalculator.hooks.js

/**
 * AnimalFeedCalculator.hooks.js
 * ---------------------------------------------------------------------------
 * How this fits:
 * - React hooks that connect the Animal Feed Calculator results to:
 *    1) SessionRunner (via a “Feed Session Now” launcher), and
 *    2) Storehouse + Meat Yield Planning (via Planning Graph style link data).
 *
 * - SessionRunner:
 *    • We build a Session object from the feed plan result.
 *    • We persist it to Dexie via a sessions store (soft import).
 *    • We emit a `session.requested` event (Runner listens and opens its modal).
 *
 * - Storehouse + Meat Yield Planning:
 *    • We analyze feedDemandProjection and animals to identify:
 *        - Which feed items are projected to run short.
 *        - Which meat animals might be candidates for early processing
 *          to relieve feed pressure (for meat yield calculators).
 *
 * NOTE:
 * - This file does NOT implement the SessionRunner itself. That lives at the
 *   app root and is the one responsible for:
 *   wake-lock, notifications, Web Worker timers, PiP, and emitting
 *   session.started / session.step.changed / session.completed / etc.
 */

import { useCallback, useMemo } from "react";

/* -------------------------------------------------------------------------- */
/* Soft imports: eventBus + sessions store                                    */
/* -------------------------------------------------------------------------- */

let emit = () => {};
let sessionsStore = null;

try {
  // eslint-disable-next-line import/no-unresolved
  const eventBus = require("@/services/events/eventBus");
  if (eventBus && typeof eventBus.emit === "function") {
    emit = eventBus.emit;
  }
} catch {
  // no-op; hook still works, just won't emit events
}

try {
  // eslint-disable-next-line import/no-unresolved
  // Expecting an object with upsertSession(session) or save(session)
  sessionsStore = require("@/services/session/sessionStore");
} catch {
  // no-op; we'll guard before use
}

/* -------------------------------------------------------------------------- */
/* JSDoc typedefs (mirror shim + session contract)                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {import("./AnimalFeedCalculator.shim").AnimalFeedCalculatorResult} AnimalFeedCalculatorResult
 */

/**
 * @typedef {Object} SessionSource
 * @property {"recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual"} type
 * @property {string|null} refId
 */

/**
 * @typedef {Object} SessionStepMetadata
 * @property {number} tempTargetF
 * @property {"color"|"texture"|"probeTemp"|"timer"|"smell"|string} donenessCue
 * @property {string} cueNotes
 */

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} blockers
 * @property {SessionStepMetadata} metadata
 */

/**
 * @typedef {Object} SessionPrefs
 * @property {boolean} voiceGuidance
 * @property {boolean} haptic
 * @property {boolean} autoAdvance
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
 * @property {Array<any>} adjustments
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} title
 * @property {SessionSource} source
 * @property {SessionStep[]} steps
 * @property {SessionPrefs} prefs
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {SessionProgress} progress
 * @property {SessionAnalytics} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @returns {string} ISO timestamp
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Generate a deterministic-ish session id.
 * In your real app, you may prefer a uuid helper.
 * @param {string} prefix
 */
function makeSessionId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Persist session to Dexie-backed store if available.
 * @param {Session} session
 */
async function persistSession(session) {
  if (!sessionsStore) return;
  try {
    if (typeof sessionsStore.upsertSession === "function") {
      await sessionsStore.upsertSession(session);
    } else if (typeof sessionsStore.save === "function") {
      await sessionsStore.save(session);
    }
    // else: no known method; silently ignore
  } catch {
    // ignore; SessionRunner can still pick up the session from event payload
  }
}

/**
 * Emit a `session.requested` event for SessionRunner to pick up
 * and open its modal.
 *
 * @param {Session} session
 */
function requestSessionStart(session) {
  try {
    emit({
      type: "session.requested", // Runner listens for this at app root
      ts: nowIso(),
      source: "features/calculators/AnimalFeedCalculator.hooks",
      data: { session },
    });
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/* Session builder for Animal Feed                                            */
/* -------------------------------------------------------------------------- */

/**
 * Convert a feed plan result into a Session object that SessionRunner can play.
 * Each animal/group becomes one step; this keeps the interaction focused and
 * easy for the user walking pens/barns.
 *
 * @param {AnimalFeedCalculatorResult} result
 * @returns {Session}
 */
export function buildFeedSessionFromResult(result) {
  const createdAt = nowIso();
  const id = makeSessionId("animals-feed");
  const horizon = result?.context?.planningHorizonDays || 1;

  const steps = [];

  for (const plan of result.dailyFeedPlan || []) {
    const subject = (result.animals || []).find((a) => a.id === plan.subjectId);
    const subjectName = subject?.displayName || subject?.id || "Animal group";
    const headCount = subject?.count || 1;
    const location = subject?.location || "Unknown location";

    const asFedPerHead = plan.totals?.asFedKgPerHeadPerDay ?? 0;
    const dmPerHead = plan.totals?.dryMatterKgPerHeadPerDay ?? 0;

    const feedLines = (plan.feedItems || []).map((item) => {
      const perHead = item.asFedKgPerHeadPerDay ?? 0;
      return `• ${item.name} – ${perHead.toFixed(2)} kg / head`;
    });

    const descParts = [
      `Feed ${headCount} head in ${location}.`,
      "",
      `Per head (daily):`,
      `- As-fed: ${asFedPerHead.toFixed(2)} kg`,
      `- Dry matter: ${dmPerHead.toFixed(2)} kg`,
      "",
      `Feed components:`,
      ...feedLines,
      "",
      `Planning horizon: ${horizon} day(s).`,
    ];

    /** @type {SessionStep} */
    const step = {
      id: `${id}-step-${plan.rationId}`,
      title: `Feed ${subjectName}`,
      desc: descParts.join("\n"),
      // 5 minutes per group as a safe default; can be tuned later or made dynamic
      durationSec: 5 * 60,
      blockers: ["inventory", "quietHours", "sabbath"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Confirm all animals have access to clean water and feed bunk is not overcrowded.",
      },
    };

    steps.push(step);
  }

  /** @type {Session} */
  const session = {
    id,
    domain: "animals",
    title: "Feed Animals – Today’s Round",
    source: {
      type: "animalTask",
      refId: null,
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

/* -------------------------------------------------------------------------- */
/* Hook: launch Feed Session Now                                              */
/* -------------------------------------------------------------------------- */

/**
 * Hook exposed to the view layer to trigger a “Feed Session Now”
 * from an AnimalFeedCalculatorResult.
 *
 * SessionRunner responsibilities (outside this file):
 * - Listen for `session.requested` events.
 * - Persist current session checkpoints to Dexie.
 * - Emit session.started / session.step.changed / session.completed / etc.
 *
 * @param {{ feedPlanResult: AnimalFeedCalculatorResult|null }} options
 */
export function useAnimalFeedSessionLaunchers(options) {
  const { feedPlanResult } = options || {};

  const launchFeedSessionNow = useCallback(
    /**
     * @param {AnimalFeedCalculatorResult|null|undefined} overrideResult
     */
    async (overrideResult) => {
      const result = overrideResult || feedPlanResult;
      if (!result || !Array.isArray(result.dailyFeedPlan)) return;

      const session = buildFeedSessionFromResult(result);
      // Persist to Dexie if available
      await persistSession(session);
      // Ask SessionRunner to start it
      requestSessionStart(session);
    },
    [feedPlanResult]
  );

  return { launchFeedSessionNow };
}

/* -------------------------------------------------------------------------- */
/* Hook: link feed plan → storehouse + meat yield planning                    */
/* -------------------------------------------------------------------------- */

/**
 * Analyze feedDemandProjection + animals to produce Planning Graph-style
 * “next action” hints for:
 * - Storehouse refill / purchases
 * - Potential meat yield planning (animals to process to relieve feed demand)
 *
 * This is read-only: it does not create sessions itself, but gives the UI
 * & planners structured data to work with.
 *
 * @param {AnimalFeedCalculatorResult|null} feedPlanResult
 */
export function useAnimalFeedPlanningLinks(feedPlanResult) {
  return useMemo(() => {
    if (!feedPlanResult) {
      return {
        hasShortages: false,
        shortageItems: [],
        storehouseRefillPlan: null,
        meatYieldCandidates: [],
        summary: null,
      };
    }

    const demand = Array.isArray(feedPlanResult.feedDemandProjection)
      ? feedPlanResult.feedDemandProjection
      : [];
    const animals = Array.isArray(feedPlanResult.animals)
      ? feedPlanResult.animals
      : [];

    const shortageItems = demand.filter(
      (d) => (d.projectedShortageKg || 0) > 0
    );

    // Build a simple storehouse refill suggestion payload
    const storehouseRefillPlan =
      shortageItems.length === 0
        ? null
        : {
            nodeKey: "storehouse.feedProcurement",
            suggestedAt: feedPlanResult.context?.calculatedAt || null,
            horizonDays: feedPlanResult.context?.planningHorizonDays || 7,
            items: shortageItems.map((d) => ({
              itemId: d.feedItemId,
              name: d.name,
              projectedShortageKg: d.projectedShortageKg,
              projectedUsageKg: d.projectedUsageKg,
              currentInventoryKg: d.currentInventoryKg,
              estimatedRunoutDate: d.estimatedRunoutDate,
            })),
          };

    // Meat yield planning:
    // - Look for animals with role "meat" or class "meat"
    // - Rank by weight and simple shortage pressure (how many items are short)
    const meatAnimals = animals.filter((a) => {
      const role = (a.role || "").toLowerCase();
      const cls = (a.class || "").toLowerCase();
      return role === "meat" || cls === "meat";
    });

    const meatYieldCandidates = meatAnimals
      .map((a) => {
        // naive pressure score: number of shortage items; can be refined later
        const pressureScore = shortageItems.length;
        return {
          animalId: a.id,
          displayName: a.displayName || a.id,
          species: a.species,
          weightKg: a.weightKg,
          count: a.count || 1,
          role: a.role || a.class || "meat",
          location: a.location || null,
          pressureScore,
        };
      })
      .sort((a, b) => {
        // heavier animals first, then higher pressure score
        if (b.pressureScore !== a.pressureScore) {
          return b.pressureScore - a.pressureScore;
        }
        return (b.weightKg || 0) - (a.weightKg || 0);
      });

    const hasShortages = shortageItems.length > 0;
    const summary = {
      horizonDays: feedPlanResult.context?.planningHorizonDays || 7,
      shortageItemCount: shortageItems.length,
      meatCandidateCount: meatYieldCandidates.length,
      totalAsFedKgPerDay: feedPlanResult.analytics?.totalAsFedKgPerDay ?? null,
      estimatedFeedCostPerDay:
        feedPlanResult.analytics?.estimatedFeedCostPerDay ?? null,
    };

    return {
      hasShortages,
      shortageItems,
      storehouseRefillPlan,
      meatYieldCandidates,
      summary,
    };
  }, [feedPlanResult]);
}
