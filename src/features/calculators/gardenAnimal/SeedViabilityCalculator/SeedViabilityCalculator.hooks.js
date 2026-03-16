// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\SeedViabilityCalculator\SeedViabilityCalculator.hooks.js

/**
 * SeedViabilityCalculator.hooks.js
 *
 * Hooks to connect seed viability calculations to:
 *  - garden planting flows (create “Plant Now” sessions)
 *  - storehouse refill flows (create “Refill / Replace Seeds” sessions)
 *
 * How this fits into SSA:
 *  - The Seed Viability Calculator UI calls these hooks with the user’s
 *    seed lot + test results.
 *  - Hooks:
 *      1) compute planting capacity + shortage/overage
 *      2) emit events into the SSA eventBus (for Planning Graph, inventory, etc.)
 *      3) build session objects for the SessionRunner (garden + storehouse domains)
 *      4) request “Now” sessions via eventBus so the global SessionRunner
 *         can pick them up and actually start running them.
 *
 *  - This file does NOT render UI; it only provides logic and integration
 *    points for the calculator and the SessionRunner / Hub / PlanningGraph.
 */

import { useCallback, useMemo } from "react";
import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SeedBatch
 * @property {string} id
 * @property {string} cropName
 * @property {string} [variety]
 * @property {string} [lotCode]
 * @property {number} [packedYear]        // four-digit year
 * @property {number} [labelGermPct]      // on-packet germ % (0–100)
 * @property {number} [quantityOnHand]    // count of seeds on hand
 */

/**
 * @typedef {Object} ViabilityPlanningResult
 * @property {number} effectiveViabilityPct
 * @property {number} theoreticalGerminatedSeeds
 * @property {number} maxPlantsSupported
 * @property {boolean} isShortage
 * @property {number} shortagePlants
 * @property {number} recommendedSowingMultiplier
 * @property {boolean} shouldRefill
 * @property {boolean} shouldFrontloadSowing
 */

/**
 * Compute a conservative viability % given the test result and/or packet label.
 *
 * @param {Object} params
 * @param {number} [params.testGerminated]    // seeds that sprouted in the test
 * @param {number} [params.testTotal]        // total seeds tested
 * @param {number} [params.labelGermPct]     // label germination %
 * @returns {number}                          // 0–100
 */
function computeEffectiveViabilityPct({
  testGerminated,
  testTotal,
  labelGermPct,
}) {
  const safeLabel =
    typeof labelGermPct === "number" && labelGermPct > 0 && labelGermPct <= 100
      ? labelGermPct
      : 0;

  let testPct = 0;
  if (
    typeof testGerminated === "number" &&
    typeof testTotal === "number" &&
    testTotal > 0
  ) {
    testPct = (testGerminated / testTotal) * 100;
  }

  // Conservative: take the minimum non-zero value
  const candidates = [testPct, safeLabel].filter((v) => v > 0);
  if (!candidates.length) return 0;
  return Math.max(0, Math.min(100, Math.min(...candidates)));
}

/**
 * Build a simple ISO timestamp string.
 * Kept as a helper so it’s easy to swap for a centralized time service later.
 *
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Fire-and-forget hub export, only when familyFundMode is enabled.
 * This is a progressive enhancement — SSA runs fine without the Hub.
 *
 * @param {Object} envelope
 */
function safeHubExport(envelope) {
  if (!familyFundMode) return;

  // Dynamic import so this file doesn’t hard-crash if Hub helpers are missing.
  import("@/services/hub/exportToHubIfEnabled")
    .then((mod) => {
      if (mod && typeof mod.exportToHubIfEnabled === "function") {
        return mod.exportToHubIfEnabled(envelope);
      }
      return null;
    })
    .catch(() => {
      // fail silently by design
    });
}

/**
 * Fire-and-forget persistence for a session draft into Dexie.
 * Assumes a Sessions store with an upsertSession(session) helper.
 *
 * @param {import("../../../sessions/session.types").Session | Object} session
 */
function persistSessionDraft(session) {
  if (!session || typeof session !== "object") return;

  import("@/services/session/sessionStore")
    .then((mod) => {
      if (mod && typeof mod.upsertSession === "function") {
        return mod.upsertSession(session);
      }
      return null;
    })
    .catch(() => {
      // fail silently, SessionRunner listeners can still decide how to respond
    });
}

/**
 * Emit a PlanningGraph update event when seed viability is recalculated.
 *
 * @param {Object} payload
 */
function emitPlanningGraphUpdate(payload) {
  emit({
    type: "planningGraph.node.updated",
    ts: nowIso(),
    source: "features/calculators/SeedViabilityCalculator",
    data: {
      nodeId: "garden.seedViability",
      ...payload,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Hook: useSeedViabilityPlanning                                             */
/* -------------------------------------------------------------------------- */

/**
 * Hook that computes planting capacity + refill signals for a seed batch.
 *
 * @param {Object} params
 * @param {SeedBatch} params.seedBatch
 * @param {number} [params.testGerminated]
 * @param {number} [params.testTotal]
 * @param {number} [params.targetPlants]            // plants needed from plan
 * @param {number} [params.sowingMultiplier]        // default 1.1 (10% over-sow)
 * @param {number} [params.minViabilityForRefill]   // default 65 (%)
 * @param {boolean} [params.autoEmitEvents]         // default true
 * @returns {ViabilityPlanningResult}
 */
export function useSeedViabilityPlanning({
  seedBatch,
  testGerminated,
  testTotal,
  targetPlants,
  sowingMultiplier = 1.1,
  minViabilityForRefill = 65,
  autoEmitEvents = true,
}) {
  const result = useMemo(() => {
    if (!seedBatch || typeof seedBatch !== "object") {
      return {
        effectiveViabilityPct: 0,
        theoreticalGerminatedSeeds: 0,
        maxPlantsSupported: 0,
        isShortage: false,
        shortagePlants: 0,
        recommendedSowingMultiplier: sowingMultiplier,
        shouldRefill: false,
        shouldFrontloadSowing: false,
      };
    }

    const effectiveViabilityPct = computeEffectiveViabilityPct({
      testGerminated,
      testTotal,
      labelGermPct: seedBatch.labelGermPct,
    });

    const quantityOnHand =
      typeof seedBatch.quantityOnHand === "number" &&
      seedBatch.quantityOnHand > 0
        ? seedBatch.quantityOnHand
        : 0;

    const theoreticalGerminatedSeeds = Math.floor(
      quantityOnHand * (effectiveViabilityPct / 100)
    );

    const safeTargetPlants =
      typeof targetPlants === "number" && targetPlants > 0 ? targetPlants : 0;

    const recommendedSowingMultiplier =
      effectiveViabilityPct > 0
        ? Math.max(sowingMultiplier, 100 / effectiveViabilityPct)
        : sowingMultiplier;

    const maxPlantsSupported =
      safeTargetPlants > 0
        ? Math.floor(theoreticalGerminatedSeeds / recommendedSowingMultiplier)
        : theoreticalGerminatedSeeds;

    const isShortage =
      safeTargetPlants > 0 && maxPlantsSupported < safeTargetPlants;
    const shortagePlants = isShortage
      ? safeTargetPlants - maxPlantsSupported
      : 0;

    const shouldRefill =
      effectiveViabilityPct > 0 &&
      effectiveViabilityPct < minViabilityForRefill;
    const shouldFrontloadSowing =
      effectiveViabilityPct >= minViabilityForRefill &&
      effectiveViabilityPct < 90;

    const payload = {
      batchId: seedBatch.id,
      cropName: seedBatch.cropName,
      variety: seedBatch.variety || "",
      lotCode: seedBatch.lotCode || "",
      packedYear: seedBatch.packedYear || null,
      labelGermPct: seedBatch.labelGermPct ?? null,
      testGerminated: testGerminated ?? null,
      testTotal: testTotal ?? null,
      effectiveViabilityPct,
      quantityOnHand,
      theoreticalGerminatedSeeds,
      targetPlants: safeTargetPlants,
      maxPlantsSupported,
      isShortage,
      shortagePlants,
      recommendedSowingMultiplier,
      shouldRefill,
      shouldFrontloadSowing,
    };

    if (autoEmitEvents) {
      emit({
        type: "seed.viability.calculated",
        ts: nowIso(),
        source: "features/calculators/SeedViabilityCalculator",
        data: payload,
      });

      if (isShortage) {
        emit({
          type: "inventory.shortage.detected",
          ts: nowIso(),
          source: "features/calculators/SeedViabilityCalculator",
          data: {
            domain: "garden",
            itemType: "seed",
            itemId: seedBatch.id,
            cropName: seedBatch.cropName,
            variety: seedBatch.variety || "",
            shortagePlants,
            targetPlants: safeTargetPlants,
          },
        });
      }

      emitPlanningGraphUpdate({ seedBatch: payload });
    }

    return {
      effectiveViabilityPct,
      theoreticalGerminatedSeeds,
      maxPlantsSupported,
      isShortage,
      shortagePlants,
      recommendedSowingMultiplier,
      shouldRefill,
      shouldFrontloadSowing,
    };
  }, [
    seedBatch,
    testGerminated,
    testTotal,
    targetPlants,
    sowingMultiplier,
    minViabilityForRefill,
    autoEmitEvents,
  ]);

  return result;
}

/* -------------------------------------------------------------------------- */
/* Hook: useSeedSessionLaunchers                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a Session object (garden domain) to guide planting based on a seed batch.
 *
 * @param {SeedBatch} seedBatch
 * @param {ViabilityPlanningResult} viability
 */
function buildPlantingSessionObject(seedBatch, viability) {
  if (!seedBatch || !seedBatch.id) return null;

  const ts = nowIso();
  const sessionId = `garden:${seedBatch.id}:${ts}`;

  /** @type {Object} */
  const session = {
    id: sessionId,
    domain: "garden",
    title: `Plant ${seedBatch.cropName}${
      seedBatch.variety ? ` – ${seedBatch.variety}` : ""
    }`,
    source: {
      type: "gardenPlan",
      refId: seedBatch.id,
    },
    steps: [
      {
        id: `${sessionId}:step:1`,
        title: "Gather tools and seed packet",
        desc: "Collect seed packet, hand tools, labels, and watering can.",
        durationSec: 300,
        blockers: ["equipment", "weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes:
            "Look for clear, dry working conditions and available tools.",
        },
      },
      {
        id: `${sessionId}:step:2`,
        title: "Prepare bed or containers",
        desc: "Loosen soil, smooth the surface, and mark rows or holes according to your plan.",
        durationSec: 600,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "texture",
          cueNotes: "Soil should be loose and crumbly, not waterlogged.",
        },
      },
      {
        id: `${sessionId}:step:3`,
        title: "Sow seeds at adjusted rate",
        desc: `Sow seeds at ~${
          viability?.recommendedSowingMultiplier.toFixed?.(2) || 1.1
        }× the normal rate to account for viability, then cover lightly.`,
        durationSec: 900,
        blockers: ["inventory", "weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Keep rows evenly spaced and avoid clumping seeds.",
        },
      },
      {
        id: `${sessionId}:step:4`,
        title: "Water and label",
        desc: "Water thoroughly but gently, then label the bed/containers with crop, variety, and date.",
        durationSec: 600,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "texture",
          cueNotes: "Soil should be evenly moist but not puddling.",
        },
      },
    ],
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
    createdAt: ts,
    updatedAt: ts,
  };

  return session;
}

/**
 * Build a Session object (storehouse domain) to guide seed refill / replacement.
 *
 * @param {SeedBatch} seedBatch
 * @param {ViabilityPlanningResult} viability
 */
function buildRefillSessionObject(seedBatch, viability) {
  if (!seedBatch || !seedBatch.id) return null;

  const ts = nowIso();
  const sessionId = `storehouse:seeds:${seedBatch.id}:${ts}`;

  /** @type {Object} */
  const session = {
    id: sessionId,
    domain: "storehouse",
    title: `Refill seeds – ${seedBatch.cropName}${
      seedBatch.variety ? ` – ${seedBatch.variety}` : ""
    }`,
    source: {
      type: "manual",
      refId: seedBatch.id,
    },
    steps: [
      {
        id: `${sessionId}:step:1`,
        title: "Review viability and target plantings",
        desc: "Confirm how many plants you need this season and current viability for this seed lot.",
        durationSec: 300,
        blockers: [],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: `Effective viability: ~${
            viability?.effectiveViabilityPct.toFixed?.(1) || 0
          }%`,
        },
      },
      {
        id: `${sessionId}:step:2`,
        title: "Decide on refill source",
        desc: "Choose whether to buy new seeds, save from your own crops, or trade with trusted growers.",
        durationSec: 600,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "",
        },
      },
      {
        id: `${sessionId}:step:3`,
        title: "Add to purchase / trade list",
        desc: "Add this seed variety to your storehouse procurement list with notes on quantity and timing.",
        durationSec: 300,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "",
        },
      },
      {
        id: `${sessionId}:step:4`,
        title: "Place order or schedule save",
        desc: "Order seeds or mark the calendar for when you’ll save seed from existing crops.",
        durationSec: 600,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "",
        },
      },
    ],
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
    createdAt: ts,
    updatedAt: ts,
  };

  return session;
}

/**
 * Hook that returns launcher callbacks to create “Now” sessions for:
 *  - planting with a specific seed lot
 *  - refilling/replacing a seed lot in the storehouse
 *
 * These callbacks:
 *   1) build a valid Session object
 *   2) persist it to Dexie (sessions store)
 *   3) emit a "session.requested" event that the global SessionRunner
 *      infrastructure can listen for and start the session immediately.
 *
 * @param {Object} params
 * @param {SeedBatch} params.seedBatch
 * @param {ViabilityPlanningResult} params.viability
 */
export function useSeedSessionLaunchers({ seedBatch, viability }) {
  const buildPlantingSession = useCallback(() => {
    return buildPlantingSessionObject(seedBatch, viability);
  }, [seedBatch, viability]);

  const buildRefillSession = useCallback(() => {
    return buildRefillSessionObject(seedBatch, viability);
  }, [seedBatch, viability]);

  const launchPlantingNow = useCallback(() => {
    const session = buildPlantingSession();
    if (!session) return;

    persistSessionDraft(session);

    emit({
      type: "session.requested",
      ts: nowIso(),
      source: "features/calculators/SeedViabilityCalculator",
      data: {
        reason: "seed.planting.now",
        session,
      },
    });

    safeHubExport({
      kind: "session.requested",
      domain: "garden",
      ts: nowIso(),
      payload: {
        sessionId: session.id,
        title: session.title,
        cropName: seedBatch?.cropName || "",
        variety: seedBatch?.variety || "",
        viabilityPct: viability?.effectiveViabilityPct ?? null,
      },
    });
  }, [buildPlantingSession, seedBatch, viability]);

  const launchRefillNow = useCallback(() => {
    const session = buildRefillSession();
    if (!session) return;

    persistSessionDraft(session);

    emit({
      type: "session.requested",
      ts: nowIso(),
      source: "features/calculators/SeedViabilityCalculator",
      data: {
        reason: "seed.refill.now",
        session,
      },
    });

    safeHubExport({
      kind: "session.requested",
      domain: "storehouse",
      ts: nowIso(),
      payload: {
        sessionId: session.id,
        title: session.title,
        cropName: seedBatch?.cropName || "",
        variety: seedBatch?.variety || "",
        viabilityPct: viability?.effectiveViabilityPct ?? null,
      },
    });
  }, [buildRefillSession, seedBatch, viability]);

  return {
    buildPlantingSession,
    buildRefillSession,
    launchPlantingNow,
    launchRefillNow,
  };
}
