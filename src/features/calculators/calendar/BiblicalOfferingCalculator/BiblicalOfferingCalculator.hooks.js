// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\BiblicalOfferingCalculator\BiblicalOfferingCalculator.hooks.js

/**
 * BiblicalOfferingCalculator.hooks.js
 *
 * How this fits:
 * - React hooks that connect the BiblicalOfferingCalculator shim + output
 *   into the rest of SSA:
 *   • Study Planner (study plans, lessons, sessions)
 *   • Calendar (events for “offering study nights”)
 *   • Global SessionRunner (via session.created events)
 *   • Optional Hub export when familyFundMode is enabled
 *
 * These hooks are intentionally light and composable:
 * - No direct UI concerns.
 * - No Dexie wiring here; that should sit in planner/calendar stores.
 * - Safe feature detection & try/catch around Hub + flags.
 */

import { useMemo, useCallback } from "react";
import { emit as emitEvent } from "@/services/eventBus";
import { featureFlags } from "@/services/featureFlags";

// Hub helpers are optional; wrap in try/catch so this file is safe if they move.
let HubPacketFormatter;
let FamilyFundConnector;
try {
  // eslint-disable-next-line global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  // eslint-disable-next-line global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {
  HubPacketFormatter = null;
  FamilyFundConnector = null;
}

/**
 * @typedef {import("./BiblicalOfferingCalculator.shim").BiblicalOfferingCalculatorOutput} BiblicalOfferingCalculatorOutput
 */

/**
 * Hook: useBiblicalOfferingStudyPlans
 *
 * Given a BiblicalOfferingCalculatorOutput, derive a list of “study modules”
 * that a Study Planner feature can store, render, and schedule.
 *
 * @param {BiblicalOfferingCalculatorOutput|null} output
 * @param {{ householdId?: string; academicYearId?: string; }} [options]
 */
export function useBiblicalOfferingStudyPlans(output, options) {
  const { householdId = null, academicYearId = null } = options || {};

  return useMemo(() => {
    if (!output || typeof output !== "object") return [];

    const nowIso = new Date().toISOString();
    const keyPrefix = `offering/${output.offeringType || "unknown"}`;

    const baseTitle =
      output.canonicalSummary?.label ||
      `Offering Study: ${capitalize(output.offeringType || "offering")}`;

    /** @type {Array<{
     *   id: string;
     *   title: string;
     *   focus: string;
     *   scriptures: string[];
     *   householdId: string|null;
     *   academicYearId: string|null;
     *   tags: string[];
     *   createdAt: string;
     *   meta: Record<string, any>;
     * }>} */
    const plans = [];

    // Plan 1: Canonical overview module
    plans.push({
      id: createEphemeralId(`${keyPrefix}/overview`),
      title: `${baseTitle} – Overview`,
      focus: "overview",
      scriptures: output.canonicalSummary?.coreScriptures || [],
      householdId,
      academicYearId,
      tags: [
        "offerings",
        "overview",
        output.offeringType || "offering",
        "torah-study"
      ],
      createdAt: nowIso,
      meta: {
        summary: output.canonicalSummary?.briefExplanation || "",
        recommendedAudience: "household-all-ages",
        fromCalculator: "biblical-offering-calculator"
      }
    });

    // Plan 2: Animal patterns (if any)
    if (Array.isArray(output.animalPatterns) && output.animalPatterns.length) {
      plans.push({
        id: createEphemeralId(`${keyPrefix}/animals`),
        title: `${baseTitle} – Animals & Defects`,
        focus: "animals",
        scriptures: output.canonicalSummary?.coreScriptures || [],
        householdId,
        academicYearId,
        tags: [
          "offerings",
          "animals",
          "husbandry",
          "meat",
          output.offeringType || "offering"
        ],
        createdAt: nowIso,
        meta: {
          animalPatterns: output.animalPatterns,
          suggestedActivities: [
            "compare permitted animals by age/sex",
            "map offerings to current livestock or potential acquisitions",
            "discuss why defects are disallowed"
          ]
        }
      });
    }

    // Plan 3: Grain & drink patterns
    if (
      Array.isArray(output.grainDrinkPatterns) &&
      output.grainDrinkPatterns.length
    ) {
      plans.push({
        id: createEphemeralId(`${keyPrefix}/grain-drink`),
        title: `${baseTitle} – Grain & Drink Elements`,
        focus: "grain-drink",
        scriptures: output.canonicalSummary?.coreScriptures || [],
        householdId,
        academicYearId,
        tags: [
          "offerings",
          "grain",
          "drink",
          "breadmaking",
          "wine",
          output.offeringType || "offering"
        ],
        createdAt: nowIso,
        meta: {
          grainDrinkPatterns: output.grainDrinkPatterns,
          suggestedActivities: [
            "connect grain offerings to breadmaking sessions",
            "study firstfruits and libations as celebration of provision"
          ]
        }
      });
    }

    // Plan 4: Study prompts distilled into standalone “question-driven” module
    if (Array.isArray(output.studyPrompts) && output.studyPrompts.length) {
      plans.push({
        id: createEphemeralId(`${keyPrefix}/prompts`),
        title: `${baseTitle} – Reflection Questions`,
        focus: "prompts",
        scriptures: output.canonicalSummary?.coreScriptures || [],
        householdId,
        academicYearId,
        tags: ["offerings", "reflection", "discussion", "journal"],
        createdAt: nowIso,
        meta: {
          prompts: output.studyPrompts,
          recommendedUse: "family-evening-discussion-or-class"
        }
      });
    }

    return plans;
  }, [output, householdId, academicYearId]);
}

/**
 * Hook: useOfferingCalendarEvents
 *
 * Converts an offering study output into calendar events, such as:
 * - “Offering overview night”
 * - “Animals & defects night”
 * - “Grain & drink night”
 *
 * Events returned here are shaped generically so a Calendar store can
 * persist them in Dexie and push them into a UI calendar.
 *
 * @param {BiblicalOfferingCalculatorOutput|null} output
 * @param {{
 *   startDate?: string;      // ISO – first session date
 *   intervalDays?: number;   // gap between events, default 7
 *   calendarId?: string;     // optional calendar identifier
 * }} [options]
 */
export function useOfferingCalendarEvents(output, options) {
  const {
    startDate,
    intervalDays = 7,
    calendarId = "household-scripture"
  } = options || {};

  return useMemo(() => {
    if (!output) return [];

    const baseTitle =
      output.canonicalSummary?.label ||
      `Offering Study: ${capitalize(output.offeringType || "offering")}`;

    const events = [];
    const anchorDate = startDate ? new Date(startDate) : new Date();
    const safeInterval = Number.isFinite(intervalDays) ? intervalDays : 7;

    // Event 1: Overview
    events.push(
      createOfferingEvent({
        calendarId,
        baseTitle: `${baseTitle} – Overview`,
        offsetDays: 0,
        anchorDate,
        description:
          output.canonicalSummary?.briefExplanation ||
          "Overview of this offering, its heart posture, and anchor passages.",
        scriptures: output.canonicalSummary?.coreScriptures || []
      })
    );

    // Event 2: Animals
    if (Array.isArray(output.animalPatterns) && output.animalPatterns.length) {
      events.push(
        createOfferingEvent({
          calendarId,
          baseTitle: `${baseTitle} – Animals & Defects`,
          offsetDays: safeInterval,
          anchorDate,
          description:
            "Study animals associated with this offering—species, age, sex, and defect rules.",
          scriptures: output.canonicalSummary?.coreScriptures || []
        })
      );
    }

    // Event 3: Grain & Drink
    if (
      Array.isArray(output.grainDrinkPatterns) &&
      output.grainDrinkPatterns.length
    ) {
      events.push(
        createOfferingEvent({
          calendarId,
          baseTitle: `${baseTitle} – Grain & Drink Elements`,
          offsetDays: safeInterval * 2,
          anchorDate,
          description:
            "Explore grain and drink elements—measures, oils, and how they picture provision.",
          scriptures: output.canonicalSummary?.coreScriptures || []
        })
      );
    }

    // Event 4: Reflections
    if (Array.isArray(output.studyPrompts) && output.studyPrompts.length) {
      events.push(
        createOfferingEvent({
          calendarId,
          baseTitle: `${baseTitle} – Reflection & Response`,
          offsetDays: safeInterval * 3,
          anchorDate,
          description:
            "Work through reflection questions and journal or discuss the heart posture of this offering.",
          scriptures: output.canonicalSummary?.coreScriptures || []
        })
      );
    }

    return events;
  }, [output, startDate, intervalDays, calendarId]);
}

/**
 * Hook: useOfferingStudySessionLauncher
 *
 * Returns a callback that, when invoked, emits a `session.created` event with
 * a Session object tailored for a study session for the output’s offering type.
 * The SessionRunner listening at app root can then pick this up.
 *
 * @param {BiblicalOfferingCalculatorOutput|null} output
 */
export function useOfferingStudySessionLauncher(output) {
  return useCallback(() => {
    if (!output) return;

    const nowIso = new Date().toISOString();
    const sessionId = createEphemeralId(
      `offering-session/${output.offeringType || "offering"}`
    );

    const steps = buildStudySessionStepsFromResult(output);

    const session = {
      id: sessionId,
      domain: "storehouse",
      title:
        output.canonicalSummary?.label ||
        `Offering Study Session – ${capitalize(output.offeringType || "offering")}`,
      source: {
        type: "manual",
        refId: null
      },
      steps,
      prefs: {
        voiceGuidance: true,
        haptic: false,
        autoAdvance: false
      },
      status: "pending",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null
      },
      analytics: {
        skippedSteps: [],
        adjustments: []
      },
      createdAt: nowIso,
      updatedAt: nowIso
    };

    try {
      emitEvent({
        type: "session.created",
        ts: nowIso,
        source: "calculators/calendar/BiblicalOfferingCalculator/hooks",
        data: { session }
      });

      exportOfferingStudyToHubIfEnabled(output, session);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[BiblicalOfferingCalculator.hooks] Failed to emit session.created or export:",
        err
      );
    }
  }, [output]);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} prefix
 * @returns {string}
 */
function createEphemeralId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function capitalize(value) {
  if (!value || typeof value !== "string") return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Create a generic calendar event object.
 *
 * @param {{
 *   calendarId: string;
 *   baseTitle: string;
 *   anchorDate: Date;
 *   offsetDays: number;
 *   description: string;
 *   scriptures: string[];
 * }} opts
 */
function createOfferingEvent(opts) {
  const { calendarId, baseTitle, anchorDate, offsetDays, description, scriptures } =
    opts;

  const start = new Date(anchorDate.getTime());
  start.setDate(start.getDate() + offsetDays);

  const end = new Date(start.getTime());
  // 90 minute default study block
  end.setMinutes(end.getMinutes() + 90);

  return {
    id: createEphemeralId("offering-event"),
    calendarId,
    title: baseTitle,
    start: start.toISOString(),
    end: end.toISOString(),
    description,
    meta: {
      type: "offering-study",
      scriptures
    }
  };
}

/**
 * Build Session.steps from the calculator output.
 * Keeps durations modest so SessionRunner timers are friendly.
 *
 * @param {BiblicalOfferingCalculatorOutput} result
 */
function buildStudySessionStepsFromResult(result) {
  if (!result || typeof result !== "object") return [];

  const steps = [];

  // Step 1 – Open & Pray
  steps.push({
    id: createEphemeralId("step/open"),
    title: "Open in Prayer & Intent",
    desc:
      "Gather your household, open in prayer, and state the intent of this study: to understand this offering and its heart posture.",
    durationSec: 5 * 60,
    blockers: ["quietHours"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes: "Short opening segment. Can be extended if family discussion is flowing."
    }
  });

  // Step 2 – Read anchor scriptures
  const scriptureList = result.canonicalSummary?.coreScriptures || [];
  steps.push({
    id: createEphemeralId("step/read-anchor"),
    title: "Read Anchor Passages",
    desc:
      scriptureList.length > 0
        ? `Read the anchor passages for this offering: ${scriptureList.join(
            "; "
          )}.`
        : "Read the main passages describing this offering in Torah.",
    durationSec: 15 * 60,
    blockers: ["quietHours"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes:
        "Take turns reading aloud. Invite older children or adults to read longer sections."
    }
  });

  // Step 3 – Walk through animal patterns (optional)
  if (Array.isArray(result.animalPatterns) && result.animalPatterns.length) {
    steps.push({
      id: createEphemeralId("step/animals"),
      title: "Observe Animal Patterns",
      desc:
        "Review which animals are used in this offering. Discuss age, sex, and defect rules and why they might matter.",
      durationSec: 10 * 60,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Optionally connect this to current or future livestock plans using SSA's animal tools."
      }
    });
  }

  // Step 4 – Grain & drink elements (optional)
  if (
    Array.isArray(result.grainDrinkPatterns) &&
    result.grainDrinkPatterns.length
  ) {
    steps.push({
      id: createEphemeralId("step/grain-drink"),
      title: "Review Grain & Drink Elements",
      desc:
        "Look at the grain and drink measures. Compare them to your family’s bread, oil, and drink usage.",
      durationSec: 10 * 60,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Optionally schedule a breadmaking or grape-juice making session as a follow-up."
      }
    });
  }

  // Step 5 – Reflection prompts
  if (Array.isArray(result.studyPrompts) && result.studyPrompts.length) {
    steps.push({
      id: createEphemeralId("step/reflection"),
      title: "Reflection & Response",
      desc:
        "Choose 2–3 reflection questions from the list and discuss or journal responses as a household.",
      durationSec: 15 * 60,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Keep it gentle and open. The goal is understanding and heart posture, not interrogation."
      }
    });
  }

  // Step 6 – Close in prayer / practical next step
  steps.push({
    id: createEphemeralId("step/close"),
    title: "Close & Plan a Small Next Step",
    desc:
      "Close in prayer, then pick one small next step: a reminder, a study note, or a practice to remember what you’ve learned.",
    durationSec: 5 * 60,
    blockers: [],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes:
        "You might schedule another study, add a note to SSA, or link this offering to a future feast preparation session."
    }
  });

  return steps;
}

/**
 * If familyFundMode is enabled and Hub helpers exist, send a compact summary
 * of this offering study to the Hub for optional sharing or analytics.
 *
 * @param {BiblicalOfferingCalculatorOutput} output
 * @param {any} session
 */
function exportOfferingStudyToHubIfEnabled(output, session) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;

  try {
    const payload = {
      calculatorId: "biblical-offering-calculator",
      offeringType: output.offeringType,
      canonicalSummary: output.canonicalSummary,
      createdSessionId: session?.id || null,
      createdAt: session?.createdAt || new Date().toISOString()
    };

    const packet = HubPacketFormatter.format({
      kind: "offering.study-session",
      payload
    });

    FamilyFundConnector.send(packet);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[BiblicalOfferingCalculator.hooks] exportOfferingStudyToHubIfEnabled failed:",
      err
    );
  }
}
