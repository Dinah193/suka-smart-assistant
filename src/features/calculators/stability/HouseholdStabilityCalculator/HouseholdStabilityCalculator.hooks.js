// C:\Users\larho\suka-smart-assistant\src\features\calculators\stability\HouseholdStabilityCalculator\HouseholdStabilityCalculator.hooks.js

/**
 * HouseholdStabilityCalculator.hooks.js
 *
 * How this fits:
 * - React hooks that sit between the Stability shim/view and:
 *    • Planning Graph events,
 *    • “Now” session recommendations for SessionRunner,
 *    • optional Hub export when familyFundMode is enabled.
 *
 * Responsibilities:
 * - Normalize stability shim output into grouped recommendations for the UI.
 * - Map recommendations into session templates compatible with the SessionRunner
 *   contract (domain/title/steps/etc.).
 * - Emit events so the Planning Graph and other SSA features can react.
 *
 * These hooks DO NOT own any UI — they are logic only.
 */

import { useCallback, useMemo } from "react";
import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

// You can replace this with a real helper later.
// For now it's a safe no-op so this file is standalone.
const exportToHubIfEnabled = async (payload) => {
  if (!familyFundMode) return;
  try {
    // eslint-disable-next-line no-console
    console.log("[SSA][Hub] Household stability export (stub):", payload);
  } catch {
    // fail silently by design
  }
};

const NODE_KEY = "household-stability";

/* -------------------------------------------------------------------------- */
/* 1) Hook: Normalize & group recommendations                                 */
/* -------------------------------------------------------------------------- */

/**
 * useHouseholdStabilityRecommendations
 *
 * Takes raw stability calculator output and:
 *  - groups recommendations by domain,
 *  - identifies “Now” candidates to feed SessionRunner,
 *  - exposes quick flags for critical/fragile band.
 *
 * @param {object|null} stabilityResult Output from HouseholdStabilityCalculator.shim.run
 */
export function useHouseholdStabilityRecommendations(stabilityResult) {
  return useMemo(() => {
    if (!stabilityResult) {
      return {
        band: null,
        stabilityIndex: null,
        alerts: [],
        recommendations: [],
        groupedByDomain: {},
        nowCandidates: [],
        hasCriticalBand: false,
        hasFragileBand: false,
      };
    }

    const {
      band,
      stabilityIndex,
      alerts = [],
      recommendations = [],
    } = stabilityResult;

    const groupedByDomain = {};
    const nowCandidates = [];

    recommendations.forEach((rec) => {
      const domainKey = rec.domain || "general";
      if (!groupedByDomain[domainKey]) {
        groupedByDomain[domainKey] = [];
      }
      groupedByDomain[domainKey].push(rec);

      // Simple heuristic for “Now” (can evolve later)
      const priority = rec.priority || "medium";
      if (priority === "high" || priority === "urgent") {
        nowCandidates.push(rec);
      }
    });

    const hasCriticalBand = band === "critical";
    const hasFragileBand = band === "fragile";

    return {
      band,
      stabilityIndex,
      alerts,
      recommendations,
      groupedByDomain,
      nowCandidates,
      hasCriticalBand,
      hasFragileBand,
    };
  }, [stabilityResult]);
}

/* -------------------------------------------------------------------------- */
/* 2) Hook: Emit stability result to Planning Graph                           */
/* -------------------------------------------------------------------------- */

/**
 * useEmitStabilityToPlanningGraph
 *
 * Returns a function that:
 *  - emits a planningGraph.node.evaluated event with stability details,
 *  - optionally exports a Hub packet (stubbed here).
 *
 * Intended to be called once per calculation, from the page container.
 *
 * @returns {(input: any, output: any) => Promise<void>}
 */
export function useEmitStabilityToPlanningGraph() {
  return useCallback(async (input, output) => {
    if (!output) return;

    const ts = new Date().toISOString();

    // Planning Graph node evaluation event
    emit({
      type: "planningGraph.node.evaluated",
      ts,
      source: "features/calculators/stability/HouseholdStabilityCalculator",
      data: {
        nodeKey: NODE_KEY,
        input,
        output,
      },
    });

    // Stability-specific event
    emit({
      type: "stability.index.calculated",
      ts,
      source: "features/calculators/stability/HouseholdStabilityCalculator",
      data: {
        nodeKey: NODE_KEY,
        band: output.band,
        stabilityIndex: output.stabilityIndex,
        subScores: output.subScores,
        alerts: output.alerts,
      },
    });

    // Optional Hub export (stub)
    if (familyFundMode) {
      const hubPayload = {
        kind: "household.stability.summary",
        nodeKey: NODE_KEY,
        calculatedAt: ts,
        stabilityIndex: output.stabilityIndex,
        band: output.band,
        subScores: output.subScores || {},
        alerts: output.alerts || [],
      };
      await exportToHubIfEnabled(hubPayload);
    }
  }, []);
}

/* -------------------------------------------------------------------------- */
/* 3) Hook: Map recommendations → Session templates (“Now” sessions)          */
/* -------------------------------------------------------------------------- */

/**
 * Internal mapping from recommendation domain → SSA session domain.
 *
 * SSA session domains per contract:
 *  "cooking|cleaning|garden|animals|preservation|storehouse"
 */
const REC_DOMAIN_TO_SESSION_DOMAIN = {
  meals: "cooking",
  kitchen: "cooking",
  storehouse: "storehouse",
  pantry: "storehouse",
  cleaning: "cleaning",
  routines: "cleaning",
  rhythm: "cleaning",
  garden: "garden",
  preservation: "preservation",
  animals: "animals",
  livestock: "animals",
  health: "storehouse", // often vitamins/foods; can be refined later
  finance: "storehouse", // storehouse & budget connection
  relationships: "storehouse", // for now; can be mapped to a future domain
  general: "storehouse",
};

/**
 * Build a minimal-but-usable session object from a stability recommendation.
 *
 * This is a template: SessionRunner can refine, expand steps, and persist.
 *
 * @param {object} recommendation One item from stabilityResult.recommendations
 * @param {object} stabilityResult Full stability output for context
 * @returns {object} sessionTemplate
 */
function buildSessionFromRecommendation(recommendation, stabilityResult) {
  if (!recommendation) return null;

  const now = new Date().toISOString();
  const sessionDomain =
    REC_DOMAIN_TO_SESSION_DOMAIN[recommendation.domain] || "storehouse";

  const title =
    recommendation.label ||
    `Stability Follow-up: ${recommendation.domain || "Household"}`;

  const description =
    recommendation.description ||
    recommendation.details ||
    stabilityResult?.statusSummary ||
    "Follow-up action to improve household stability.";

  const stepIdBase = recommendation.id || `stability-${Date.now()}`;

  /** @type {import("../../../../types").Session} */
  const sessionTemplate = {
    id: `stability-${stepIdBase}-${now}`,
    domain: sessionDomain,
    title,
    source: {
      type: "manual",
      refId: NODE_KEY,
    },
    steps: [
      {
        id: `${stepIdBase}-prep`,
        title: `Review stability notes for '${title}'`,
        desc:
          "Review the stability calculator notes, band, and alerts. Decide what a realistic improvement looks like for the next 30–90 days.",
        durationSec: 10 * 60,
        blockers: ["sabbath", "quietHours"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Treat this as a planning huddle, not a rushed task.",
        },
      },
      {
        id: `${stepIdBase}-action`,
        title: recommendation.label || "Take first stabilizing action",
        desc:
          recommendation.sessionHint ||
          "Choose one small, concrete action that directly improves this domain (e.g., set a weekly batch cooking block, create a mini cleaning route, or schedule a garden prep session).",
        durationSec: 20 * 60,
        blockers: ["inventory", "quietHours", "sabbath"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes:
            "Aim for a single action that is easy to repeat weekly rather than a big one-time push.",
        },
      },
    ],
    prefs: {
      voiceGuidance: true,
      haptic: false,
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
    createdAt: now,
    updatedAt: now,
  };

  return sessionTemplate;
}

/**
 * useStabilitySessionsFromRecommendations
 *
 * Returns a function that converts stability recommendations into
 * SessionRunner-compatible session templates + emits events when you create one.
 *
 * @returns {{
 *   buildSession: (recommendation: any, stabilityResult: any) => any,
 *   buildAllSessions: (recommendations: any[], stabilityResult: any) => any[]
 * }}
 */
export function useStabilitySessionsFromRecommendations() {
  const buildSession = useCallback((recommendation, stabilityResult) => {
    if (!recommendation) return null;
    const session = buildSessionFromRecommendation(
      recommendation,
      stabilityResult
    );
    if (!session) return null;

    const ts = new Date().toISOString();

    emit({
      type: "session.template.created.fromStability",
      ts,
      source: "features/calculators/stability/HouseholdStabilityCalculator",
      data: {
        nodeKey: NODE_KEY,
        recommendationId: recommendation.id,
        recommendationDomain: recommendation.domain,
        session,
      },
    });

    return session;
  }, []);

  const buildAllSessions = useCallback(
    (recommendations, stabilityResult) => {
      if (!Array.isArray(recommendations) || recommendations.length === 0) {
        return [];
      }

      return recommendations
        .map((rec) => buildSession(rec, stabilityResult))
        .filter(Boolean);
    },
    [buildSession]
  );

  return { buildSession, buildAllSessions };
}

/* -------------------------------------------------------------------------- */
/* 4) Hook: Convenience wrapper for “Now” CTAs                                */
/* -------------------------------------------------------------------------- */

/**
 * useStabilityNowHandler
 *
 * - Takes full stabilityResult.
 * - Uses useHouseholdStabilityRecommendations + useStabilitySessionsFromRecommendations
 *   under the hood.
 * - Returns:
 *    • nowCandidates: raw recommendation objects,
 *    • onPlayNow(rec, { openSession }) → builds a session and hands it to caller.
 *
 * Caller is responsible for actually opening SessionRunner with the session object.
 *
 * @param {object|null} stabilityResult
 * @returns {{
 *   nowCandidates: any[],
 *   onPlayNow: (rec: any, helpers?: { openSession?: (session: any) => void }) => void
 * }}
 */
export function useStabilityNowHandler(stabilityResult) {
  const {
    nowCandidates,
  } = useHouseholdStabilityRecommendations(stabilityResult);

  const { buildSession } = useStabilitySessionsFromRecommendations();

  const onPlayNow = useCallback(
    (recommendation, helpers = {}) => {
      if (!recommendation || !stabilityResult) return;

      const session = buildSession(recommendation, stabilityResult);
      if (!session) return;

      const { openSession } = helpers;

      if (typeof openSession === "function") {
        // Parent can directly open the SessionRunner with this template.
        openSession(session);
      } else {
        // Fallback: just log; actual wiring can be added later.
        // eslint-disable-next-line no-console
        console.log(
          "[SSA] Stability Now session template (wire to SessionRunner):",
          session
        );
      }
    },
    [buildSession, stabilityResult]
  );

  return { nowCandidates, onPlayNow };
}
