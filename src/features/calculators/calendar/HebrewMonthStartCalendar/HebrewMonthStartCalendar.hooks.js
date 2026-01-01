// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\HebrewMonthStartCalendar\HebrewMonthStartCalendar.hooks.js

/**
 * HebrewMonthStartCalendar.hooks.js
 *
 * How this fits:
 * - Bridges the HebrewMonthStartCalendar shim outputs into:
 *   1) Planting & garden windows (by month and crop profile).
 *   2) Feast / appointed-time planning sessions for SSA.
 *
 * - Exposes pure mapping helpers + React hooks so:
 *   - Garden pages can show “Next planting window (per your Hebrew calendar)”.
 *   - Feast / storehouse pages can pre-build sessions for cooking / prep.
 *   - The “Now” buttons on domain pages can pull from these derived sessions.
 *
 * - Emits SSA events so the Planning Graph and SessionRunner can pick them up:
 *   • planningGraph.calendar.planting.derived
 *   • planningGraph.calendar.feasts.derived
 *   • session.builder.requested (when user wants to convert into sessions)
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
// If you already have a hub export helper, point this import there.
import { exportToHubIfEnabled } from "@/services/hubExport";

/**
 * @typedef {import("./HebrewMonthStartCalendar.shim").MonthStartEntry} MonthStartEntry
 * @typedef {import("./HebrewMonthStartCalendar.shim").ShimResponse} ShimResponse
 */

/**
 * @typedef {Object} CropProfile
 * @property {string} id
 * @property {string} name
 * @property {"cool"|"warm"|"perennial"} [type]
 * @property {number[]} [preferredMonths]  Hebrew month indices (1–13) where planting is ideal
 * @property {number[]} [fallbackMonths]   Hebrew month indices that are acceptable but not ideal
 */

/**
 * @typedef {Object} PlantingWindow
 * @property {string} id
 * @property {string} cropId
 * @property {string} cropName
 * @property {number} hebrewMonth
 * @property {string} gregorianStartDate
 * @property {"primary"|"fallback"} windowType
 * @property {string[]} [flags]
 */

/**
 * @typedef {Object} FeastAnchor
 * @property {string} id
 * @property {string} feastKey
 * @property {string} feastName
 * @property {number} hebrewMonth
 * @property {number} hebrewDay
 * @property {string|null} approxGregorianDate
 * @property {string[]} [flags]
 */

/**
 * @typedef {Object} UseHebrewPlantingPlansOptions
 * @property {MonthStartEntry[]} months
 * @property {CropProfile[]} cropProfiles
 * @property {string} [zone]  // USDA / local agronomic zone code, optional for downstream logic
 */

/**
 * @typedef {Object} UseHebrewPlantingPlansResult
 * @property {PlantingWindow[]} windows
 * @property {() => void} emitPlanningGraphEvent
 */

/**
 * @typedef {Object} UseHebrewFeastSessionsOptions
 * @property {MonthStartEntry[]} months
 * @property {string} rulePresetId
 * @property {number} gregorianYear
 */

/**
 * @typedef {Object} FeastSession
 * @property {string} id
 * @property {"storehouse"|"cooking"|"animals"} domain
 * @property {string} title
 * @property {string} feastKey
 * @property {string|null} approxGregorianDate
 * @property {Object} sessionDraft
 */

/* -------------------------------------------------------------------------- */
/* 1. PURE MAPPING HELPERS                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Map month start entries + crop profiles into planting windows.
 *
 * Heuristics:
 * - When a crop lists preferredMonths, those months become "primary" windows.
 * - When it lists fallbackMonths, those become "fallback" windows.
 * - If no months are specified, we don't guess here (another layer can).
 *
 * @param {MonthStartEntry[]} months
 * @param {CropProfile[]} cropProfiles
 * @returns {PlantingWindow[]}
 */
export function mapMonthStartsToPlantingWindows(months, cropProfiles) {
  if (!Array.isArray(months) || !Array.isArray(cropProfiles)) return [];

  /** @type {PlantingWindow[]} */
  const windows = [];

  for (const crop of cropProfiles) {
    const preferred = Array.isArray(crop.preferredMonths) ? crop.preferredMonths : [];
    const fallback = Array.isArray(crop.fallbackMonths) ? crop.fallbackMonths : [];

    if (preferred.length === 0 && fallback.length === 0) continue;

    for (const m of months) {
      const monthIndex = m.monthIndex;

      if (preferred.includes(monthIndex)) {
        windows.push({
          id: `planting-${crop.id}-m${monthIndex}`,
          cropId: crop.id,
          cropName: crop.name,
          hebrewMonth: monthIndex,
          gregorianStartDate: m.gregorianStartDate,
          windowType: "primary",
          flags: m.flags || []
        });
      } else if (fallback.includes(monthIndex)) {
        windows.push({
          id: `planting-${crop.id}-m${monthIndex}-fallback`,
          cropId: crop.id,
          cropName: crop.name,
          hebrewMonth: monthIndex,
          gregorianStartDate: m.gregorianStartDate,
          windowType: "fallback",
          flags: m.flags || []
        });
      }
    }
  }

  return windows;
}

/**
 * Map month start entries into feast anchors, based on simple Hebrew-month rules.
 *
 * Note:
 * - We DO NOT compute exact Gregorian dates for each feast day here.
 * - Instead, we attach the month’s Gregorian start date as an anchor and
 *   leave precise date offsets to a later scheduler (which can plug in a
 *   more precise astronomy / date math layer).
 *
 * @param {MonthStartEntry[]} months
 * @returns {FeastAnchor[]}
 */
export function mapMonthStartsToFeastAnchors(months) {
  if (!Array.isArray(months) || months.length === 0) return [];

  /** @type {MonthStartEntry|undefined} */
  const m1 = months.find((m) => m.monthIndex === 1);
  /** @type {MonthStartEntry|undefined} */
  const m7 = months.find((m) => m.monthIndex === 7);

  /** @type {FeastAnchor[]} */
  const anchors = [];

  if (m1) {
    // Passover (14th of Month 1)
    anchors.push({
      id: `feast-pesach-m1-d14`,
      feastKey: "pesach",
      feastName: "Passover",
      hebrewMonth: 1,
      hebrewDay: 14,
      approxGregorianDate: m1.gregorianStartDate,
      flags: ["anchor-only", "approximate"]
    });

    // Unleavened Bread (15–21 of Month 1) – we store just the anchor.
    anchors.push({
      id: `feast-unleavened-m1-d15`,
      feastKey: "chagMatzot",
      feastName: "Feast of Unleavened Bread (Anchor)",
      hebrewMonth: 1,
      hebrewDay: 15,
      approxGregorianDate: m1.gregorianStartDate,
      flags: ["anchor-only", "approximate"]
    });

    // Firstfruits (day after the Sabbath within UB); we just anchor.
    anchors.push({
      id: `feast-firstfruits-m1`,
      feastKey: "firstfruits",
      feastName: "Firstfruits (Barley)",
      hebrewMonth: 1,
      hebrewDay: 16,
      approxGregorianDate: m1.gregorianStartDate,
      flags: ["anchor-only", "approximate"]
    });
  }

  if (m7) {
    // Yom Teruah (1st of Month 7)
    anchors.push({
      id: `feast-yomTeruah-m7-d1`,
      feastKey: "yomTeruah",
      feastName: "Day of Shouting / Trumpets",
      hebrewMonth: 7,
      hebrewDay: 1,
      approxGregorianDate: m7.gregorianStartDate,
      flags: ["anchor-only", "approximate"]
    });

    // Yom Kippur (10th of Month 7)
    anchors.push({
      id: `feast-yomKippur-m7-d10`,
      feastKey: "yomKippur",
      feastName: "Day of Atonement",
      hebrewMonth: 7,
      hebrewDay: 10,
      approxGregorianDate: m7.gregorianStartDate,
      flags: ["anchor-only", "approximate"]
    });

    // Sukkot (15th of Month 7)
    anchors.push({
      id: `feast-sukkot-m7-d15`,
      feastKey: "sukkot",
      feastName: "Feast of Booths / Tabernacles (Anchor)",
      hebrewMonth: 7,
      hebrewDay: 15,
      approxGregorianDate: m7.gregorianStartDate,
      flags: ["anchor-only", "approximate"]
    });
  }

  return anchors;
}

/**
 * Build lightweight session drafts for feast-related tasks based on anchors.
 *
 * These are NOT persisted here; they are session drafts that other layers can
 * feed into the SessionRunner or schedule into feast-prep flows.
 *
 * @param {FeastAnchor[]} anchors
 * @param {{ rulePresetId: string, gregorianYear: number }} meta
 * @returns {FeastSession[]}
 */
export function buildFeastSessionDrafts(anchors, meta) {
  if (!Array.isArray(anchors) || anchors.length === 0) return [];

  /** @type {FeastSession[]} */
  const sessions = [];

  for (const anchor of anchors) {
    const id = `feast-${anchor.feastKey}-${meta.gregorianYear}-${anchor.hebrewMonth}-${anchor.hebrewDay}`;

    // Choose domain based on feast type (simple heuristic).
    /** @type {"storehouse"|"cooking"|"animals"} */
    let domain = "storehouse";
    if (anchor.feastKey === "pesach" || anchor.feastKey === "chagMatzot" || anchor.feastKey === "sukkot") {
      domain = "cooking";
    } else if (anchor.feastKey === "firstfruits") {
      domain = "storehouse";
    }

    const title = `${anchor.feastName} Prep (${meta.gregorianYear})`;

    const sessionDraft = {
      id,
      domain,
      title,
      source: {
        type: "manual",
        refId: null
      },
      steps: [
        {
          id: `${id}-step-1`,
          title: "Review feast requirements",
          desc:
            "Review commands, household size, and storehouse levels to decide offerings, meals, and guest list.",
          durationSec: 1800,
          blockers: ["inventory", "quietHours"],
          metadata: {
            tempTargetF: 0,
            donenessCue: "timer",
            cueNotes: ""
          }
        },
        {
          id: `${id}-step-2`,
          title: "Build batch cooking / preparation session",
          desc:
            "Generate or link a cooking / storehouse session for this feast using SSA’s planning tools.",
          durationSec: 1200,
          blockers: ["inventory", "equipment"],
          metadata: {
            tempTargetF: 0,
            donenessCue: "timer",
            cueNotes: ""
          }
        }
      ],
      prefs: {
        voiceGuidance: true,
        haptic: true,
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    sessions.push({
      id,
      domain,
      title,
      feastKey: anchor.feastKey,
      approxGregorianDate: anchor.approxGregorianDate,
      sessionDraft
    });
  }

  return sessions;
}

/* -------------------------------------------------------------------------- */
/* 2. REACT HOOKS                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Hook: derive planting windows from Hebrew month start data.
 *
 * - Uses mapMonthStartsToPlantingWindows to build windows.
 * - Exposes an emitter to push results into the Planning Graph event bus.
 *
 * @param {UseHebrewPlantingPlansOptions} options
 * @returns {UseHebrewPlantingPlansResult}
 */
export function useHebrewPlantingPlans(options) {
  const { months, cropProfiles, zone } = options;

  const windows = useMemo(
    () => mapMonthStartsToPlantingWindows(months || [], cropProfiles || []),
    [months, cropProfiles]
  );

  const emitPlanningGraphEvent = useCallback(() => {
    if (!windows.length) return;

    const payload = {
      calculatorId: "calendar.hebrewMonthStart",
      nodeKey: "calendar.hebrewMonthStart",
      zone: zone || null,
      windows
    };

    emitSafe("planningGraph.calendar.planting.derived", payload);

    if (familyFundMode && typeof exportToHubIfEnabled === "function") {
      exportToHubIfEnabled({
        topic: "calendar.planting",
        payload,
        source: "HebrewMonthStartCalendar.hooks"
      }).catch(() => {
        // Hub export failures should never break local UX
      });
    }
  }, [windows, zone]);

  // Optional: emit automatically when windows change
  useEffect(() => {
    if (!windows.length) return;
    emitSafe("planningGraph.calendar.planting.preview", {
      windowsCount: windows.length
    });
  }, [windows]);

  return { windows, emitPlanningGraphEvent };
}

/**
 * Hook: derive feast anchors & session drafts from Hebrew month start data.
 *
 * - Builds feast anchors via mapMonthStartsToFeastAnchors.
 * - Builds session drafts via buildFeastSessionDrafts.
 * - Emits planningGraph + optional hub export.
 * - Provides a helper to request session building now.
 *
 * @param {UseHebrewFeastSessionsOptions} options
 * @returns {{
 *   anchors: FeastAnchor[],
 *   sessions: FeastSession[],
 *   emitFeastPlanningEvent: () => void,
 *   requestFeastSessionsNow: () => void
 * }}
 */
export function useHebrewFeastSessions(options) {
  const { months, rulePresetId, gregorianYear } = options;

  const anchors = useMemo(
    () => mapMonthStartsToFeastAnchors(months || []),
    [months]
  );

  const sessions = useMemo(
    () =>
      buildFeastSessionDrafts(anchors, {
        rulePresetId,
        gregorianYear
      }),
    [anchors, rulePresetId, gregorianYear]
  );

  const emitFeastPlanningEvent = useCallback(() => {
    if (!anchors.length) return;

    const payload = {
      calculatorId: "calendar.hebrewMonthStart",
      nodeKey: "calendar.hebrewMonthStart",
      rulePresetId,
      gregorianYear,
      anchors,
      sessionCount: sessions.length
    };

    emitSafe("planningGraph.calendar.feasts.derived", payload);

    if (familyFundMode && typeof exportToHubIfEnabled === "function") {
      exportToHubIfEnabled({
        topic: "calendar.feasts",
        payload,
        source: "HebrewMonthStartCalendar.hooks"
      }).catch(() => {});
    }
  }, [anchors, gregorianYear, rulePresetId, sessions.length]);

  const requestFeastSessionsNow = useCallback(() => {
    if (!sessions.length) return;

    emitSafe("session.builder.requested", {
      domain: "storehouse",
      reason: "hebrewMonthStartCalendar.feasts",
      sessions
    });
  }, [sessions]);

  // Optional preview event
  useEffect(() => {
    if (!anchors.length) return;
    emitSafe("planningGraph.calendar.feasts.preview", {
      anchorsCount: anchors.length,
      sessionsCount: sessions.length
    });
  }, [anchors.length, sessions.length]);

  return {
    anchors,
    sessions,
    emitFeastPlanningEvent,
    requestFeastSessionsNow
  };
}

/* -------------------------------------------------------------------------- */
/* 3. INTERNAL HELPERS                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Safe wrapper around eventBus.emit
 *
 * @param {string} type
 * @param {any} data
 */
function emitSafe(type, data) {
  try {
    emit({
      type,
      ts: new Date().toISOString(),
      source: "features/calculators/calendar/HebrewMonthStartCalendar.hooks",
      data
    });
  } catch {
    // Never crash if the event bus misbehaves.
  }
}
