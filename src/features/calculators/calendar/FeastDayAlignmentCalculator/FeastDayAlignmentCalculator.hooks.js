// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\FeastDayAlignmentCalculator\FeastDayAlignmentCalculator.hooks.js

/**
 * FeastDayAlignmentCalculator.hooks.js
 *
 * How this fits:
 * - Bridges feast-alignment results into other SSA domains:
 *   • cooking: feast menus, batch sessions
 *   • cleaning: pre-feast house reset sessions
 *   • preservation: curing, baking, fermenting, and leftover plans
 * - Emits *suggested sessions* via the shared eventBus so the
 *   SessionRunner + sessions store can pick them up and run.
 * - Emits a planningGraph “next steps” hint so the Planning Graph
 *   can visualize feast → flows edges.
 *
 * This file does NOT own the SessionRunner UI; it only:
 *   1) derives structured prep flows from feast output, and
 *   2) fires SSA events like `session.suggested` that other
 *      subsystems listen for.
 */

import { useCallback, useMemo } from "react";
import { emit } from "@/services/eventBus";

/**
 * @typedef {Object} FeastOutputItem
 * @property {string} code              - Stable feast code (e.g. "pesach", "yomKippur").
 * @property {string} label             - Human-readable label.
 * @property {string} category          - Category, e.g. "pilgrimage", "sabbath", "memorial".
 * @property {string|null} gregorianStartDate - ISO date (YYYY-MM-DD) when feast begins.
 * @property {string|null} gregorianEndDate   - ISO date or null for single day.
 * @property {number} hebrewMonthIndex  - 1–13 for Adar variants, etc.
 * @property {number} hebrewDay         - Day of month (1–30).
 * @property {number} hebrewSpanDays    - Duration in days.
 * @property {string|null} prepWindowStart   - ISO date string or null.
 * @property {string|null} prepWindowEnd     - ISO date string or null.
 * @property {boolean} requiresPrepSession   - Whether a bundled prep session is recommended.
 * @property {string[]} [prepSessionHints]   - Domains or tags like ["cooking","cleaning"].
 * @property {string} [notes]               - Alignment / pastoral notes.
 */

/**
 * @typedef {Object} FeastAlignmentOutput
 * @property {string} gregorianYearLabel
 * @property {FeastOutputItem[]} feasts
 */

/**
 * @typedef {Object} FeastPrepFlowItem
 * @property {string} feastCode
 * @property {string} feastLabel
 * @property {string} category
 * @property {string|null} feastStart
 * @property {string|null} feastEnd
 * @property {string|null} prepStart
 * @property {string|null} prepEnd
 * @property {string[]} tags          - e.g. ["pilgrimage","unleavened","highSabbath"]
 * @property {string} suggestedSessionId
 */

/**
 * Small helper to safely get an ISO timestamp.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Helper: coarse “tagging” from feast metadata so other tools
 * can filter / cluster suggestions.
 *
 * @param {FeastOutputItem} feast
 * @returns {string[]}
 */
function deriveTagsFromFeast(feast) {
  const tags = new Set();

  if (!feast) return [];

  if (feast.category) tags.add(feast.category);
  if (feast.requiresPrepSession) tags.add("prep-required");

  const code = (feast.code || "").toLowerCase();
  const label = (feast.label || "").toLowerCase();
  const text = `${code} ${label}`;

  if (/pesach|passover/.test(text)) {
    tags.add("unleavened");
    tags.add("major-meal");
  }
  if (/unleavened/.test(text)) {
    tags.add("no-leaven");
  }
  if (/shavuot|weeks|pentecost/.test(text)) {
    tags.add("grain-offering");
    tags.add("baked-goods");
  }
  if (/yomkippur|atonement/.test(text)) {
    tags.add("fasting");
  }
  if (/trumpet|teruah/.test(text)) {
    tags.add("trumpets");
    tags.add("assembly");
  }
  if (/sukkot|tabernacles|booths/.test(text)) {
    tags.add("outdoor");
    tags.add("multi-day");
  }
  if (/hanukkah|dedication/.test(text)) {
    tags.add("lights");
  }
  if (/purim/.test(text)) {
    tags.add("purim");
  }

  return Array.from(tags);
}

/**
 * Normalize feasts into prep “flow items” for a specific domain.
 *
 * @param {FeastAlignmentOutput | null} alignment
 * @param {"cooking"|"cleaning"|"preservation"} domain
 * @returns {FeastPrepFlowItem[]}
 */
function buildDomainFlowItems(alignment, domain) {
  if (!alignment || !Array.isArray(alignment.feasts)) return [];

  return alignment.feasts
    .filter((f) => {
      if (!f.requiresPrepSession) return false;
      const hints = f.prepSessionHints || [];
      // If hints exist, require that this domain is included, otherwise
      // allow all domains that care about feast prep.
      if (hints.length > 0 && !hints.includes(domain)) return false;
      return true;
    })
    .map((feast) => {
      const sessionId = [
        "feast-prep",
        domain,
        feast.code,
        feast.gregorianStartDate || feast.prepWindowStart || "unknown",
      ]
        .join("-")
        .replace(/[^a-zA-Z0-9\-]/g, "_");

      return {
        feastCode: feast.code,
        feastLabel: feast.label,
        category: feast.category,
        feastStart: feast.gregorianStartDate || null,
        feastEnd: feast.gregorianEndDate || feast.gregorianStartDate || null,
        prepStart: feast.prepWindowStart || null,
        prepEnd: feast.prepWindowEnd || feast.gregorianStartDate || null,
        tags: deriveTagsFromFeast(feast),
        suggestedSessionId: sessionId,
      };
    });
}

/**
 * Hook: derive domain-specific prep flow items (cooking, cleaning, preservation)
 * from a FeastDayAlignmentCalculator output.
 *
 * Use this in domain dashboards to show “Upcoming feast prep” tiles and
 * attach “Now” buttons that feed the SessionRunner.
 *
 * @param {FeastAlignmentOutput | null} alignment
 */
export function useFeastPrepFlows(alignment) {
  const cookingFlows = useMemo(
    () => buildDomainFlowItems(alignment, "cooking"),
    [alignment]
  );
  const cleaningFlows = useMemo(
    () => buildDomainFlowItems(alignment, "cleaning"),
    [alignment]
  );
  const preservationFlows = useMemo(
    () => buildDomainFlowItems(alignment, "preservation"),
    [alignment]
  );

  return {
    cookingFlows,
    cleaningFlows,
    preservationFlows,
  };
}

/**
 * Internal helper: build a Session object for a feast-domain prep flow.
 *
 * NOTE: This is intentionally coarse. Domain-specific tools (e.g. meal planner,
 * cleaning scheduler, preservation suite) can refine these sessions later.
 *
 * @param {FeastPrepFlowItem} flow
 * @param {"cooking"|"cleaning"|"preservation"} domain
 */
function buildFeastPrepSession(flow, domain) {
  const ts = nowIso();

  /** @type {import("../../../sessions/Session.types").SessionLike | any} */
  const session = {
    id: flow.suggestedSessionId,
    domain,
    title: `${flow.feastLabel} – ${domain[0].toUpperCase()}${domain.slice(1)} Prep`,
    source: {
      type: "import",
      refId: flow.feastCode,
    },
    steps: [],
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

  // Seed domain-specific steps with safe defaults that can be expanded later.
  if (domain === "cooking") {
    session.steps = [
      {
        id: `${session.id}-menu`,
        title: "Draft feast menu",
        desc: `Sketch a ${flow.feastLabel} menu and tag recipes you want to batch.`,
        durationSec: 30 * 60,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Use SSA meal planning tools to link recipes and ingredients.",
        },
      },
      {
        id: `${session.id}-batch-plan`,
        title: "Plan batch cooking sessions",
        desc: "Group recipes into 1–2 batch cooking sessions before the feast day.",
        durationSec: 25 * 60,
        blockers: [],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Feed selected recipes into Batch Cooking within SSA.",
        },
      },
    ];
  } else if (domain === "cleaning") {
    session.steps = [
      {
        id: `${session.id}-zones`,
        title: "Choose focus zones",
        desc: `Pick the key rooms/areas to ready for ${flow.feastLabel} (entryway, dining, bathroom, guest room).`,
        durationSec: 20 * 60,
        blockers: ["quietHours", "sabbath"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Respect quiet hours and sabbath guardrails.",
        },
      },
      {
        id: `${session.id}-schedule`,
        title: "Schedule cleaning mini-sessions",
        desc: "Create 2–3 short cleaning sessions leading into the feast day.",
        durationSec: 20 * 60,
        blockers: ["quietHours"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Coordinate with other household tasks to avoid overload.",
        },
      },
    ];
  } else if (domain === "preservation") {
    session.steps = [
      {
        id: `${session.id}-ingredients`,
        title: "Identify make-ahead items",
        desc: "Decide which feast dishes and staples can be preserved or prepped early.",
        durationSec: 25 * 60,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Scan pantry, freezer, and storehouse for items suited to canning, fermenting, or curing.",
        },
      },
      {
        id: `${session.id}-schedule-preserve`,
        title: "Schedule preservation sessions",
        desc: "Create 1–2 preservation sessions for cured meats, breads, ferments, or sauces.",
        durationSec: 25 * 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Verify equipment (dehydrator, pressure canner, oven) availability.",
        },
      },
    ];
  }

  // Fallback step if no domain logic assigned.
  if (!session.steps || session.steps.length === 0) {
    session.steps = [
      {
        id: `${session.id}-plan`,
        title: "Outline preparation tasks",
        desc: `List key tasks to prepare for ${flow.feastLabel} in the ${domain} domain.`,
        durationSec: 20 * 60,
        blockers: [],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Refine later via domain-specific planners.",
        },
      },
    ];
  }

  return session;
}

/**
 * Emit a planningGraph “next steps” event for feast-driven flows.
 *
 * @param {FeastPrepFlowItem[]} flows
 * @param {"cooking"|"cleaning"|"preservation"} domain
 */
function emitPlanningGraphNextSteps(flows, domain) {
  if (!flows.length) return;
  const ts = nowIso();

  emit({
    type: "planningGraph.nextSteps.suggested",
    ts,
    source: "features/calculators/calendar/FeastDayAlignmentCalculator.hooks",
    data: {
      originNodeId: "calendar.feastDayAlignment",
      domain,
      flows: flows.map((f) => ({
        feastCode: f.feastCode,
        feastLabel: f.feastLabel,
        category: f.category,
        feastStart: f.feastStart,
        feastEnd: f.feastEnd,
        prepStart: f.prepStart,
        prepEnd: f.prepEnd,
        tags: f.tags,
        suggestedSessionId: f.suggestedSessionId,
      })),
    },
  });
}

/**
 * Hook: expose “emit sessions” callbacks to domain UIs.
 *
 * Example usage in a domain dashboard:
 *
 *   const {
 *     cookingFlows,
 *     cleaningFlows,
 *     preservationFlows,
 *   } = useFeastPrepFlows(alignment);
 *
 *   const {
 *     emitCookingPrepSessions,
 *     emitCleaningPrepSessions,
 *     emitPreservationPrepSessions,
 *   } = useFeastPrepSessionEmitters({ cookingFlows, cleaningFlows, preservationFlows });
 *
 *   // Bind to buttons or “Now” CTAs:
 *   <button onClick={emitCookingPrepSessions}>Plan cooking prep</button>
 *
 * @param {{
 *   cookingFlows: FeastPrepFlowItem[];
 *   cleaningFlows: FeastPrepFlowItem[];
 *   preservationFlows: FeastPrepFlowItem[];
 * }} params
 */
export function useFeastPrepSessionEmitters({
  cookingFlows,
  cleaningFlows,
  preservationFlows,
}) {
  const emitCookingPrepSessions = useCallback(() => {
    if (!Array.isArray(cookingFlows) || cookingFlows.length === 0) return;

    const ts = nowIso();
    cookingFlows.forEach((flow) => {
      const session = buildFeastPrepSession(flow, "cooking");

      emit({
        type: "session.suggested",
        ts,
        source:
          "features/calculators/calendar/FeastDayAlignmentCalculator.hooks/cooking",
        data: {
          session,
          feastCode: flow.feastCode,
          feastLabel: flow.feastLabel,
          domain: "cooking",
        },
      });
    });

    emitPlanningGraphNextSteps(cookingFlows, "cooking");
  }, [cookingFlows]);

  const emitCleaningPrepSessions = useCallback(() => {
    if (!Array.isArray(cleaningFlows) || cleaningFlows.length === 0) return;

    const ts = nowIso();
    cleaningFlows.forEach((flow) => {
      const session = buildFeastPrepSession(flow, "cleaning");

      emit({
        type: "session.suggested",
        ts,
        source:
          "features/calculators/calendar/FeastDayAlignmentCalculator.hooks/cleaning",
        data: {
          session,
          feastCode: flow.feastCode,
          feastLabel: flow.feastLabel,
          domain: "cleaning",
        },
      });
    });

    emitPlanningGraphNextSteps(cleaningFlows, "cleaning");
  }, [cleaningFlows]);

  const emitPreservationPrepSessions = useCallback(() => {
    if (!Array.isArray(preservationFlows) || preservationFlows.length === 0)
      return;

    const ts = nowIso();
    preservationFlows.forEach((flow) => {
      const session = buildFeastPrepSession(flow, "preservation");

      emit({
        type: "session.suggested",
        ts,
        source:
          "features/calculators/calendar/FeastDayAlignmentCalculator.hooks/preservation",
        data: {
          session,
          feastCode: flow.feastCode,
          feastLabel: flow.feastLabel,
          domain: "preservation",
        },
      });
    });

    emitPlanningGraphNextSteps(preservationFlows, "preservation");
  }, [preservationFlows]);

  return {
    emitCookingPrepSessions,
    emitCleaningPrepSessions,
    emitPreservationPrepSessions,
  };
}

/**
 * Convenience hook: one call to wire everything up.
 *
 *   const {
 *     cookingFlows,
 *     cleaningFlows,
 *     preservationFlows,
 *     emitCookingPrepSessions,
 *     emitCleaningPrepSessions,
 *     emitPreservationPrepSessions,
 *   } = useFeastPrepFlowsWithEmitters(alignment);
 *
 * This is ideal for the Calendar dashboard or a “Feast Control Center”
 * card with three “Plan Now” CTAs.
 *
 * @param {FeastAlignmentOutput | null} alignment
 */
export function useFeastPrepFlowsWithEmitters(alignment) {
  const flows = useFeastPrepFlows(alignment);
  const emitters = useFeastPrepSessionEmitters(flows);

  return {
    ...flows,
    ...emitters,
  };
}
