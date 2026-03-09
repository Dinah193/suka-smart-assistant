// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MovementIntensityCalculator\MovementIntensityCalculator.hooks.js

/**
 * MovementIntensityCalculator.hooks.js
 *
 * Hooks used to tie the Movement Intensity Calculator into:
 * - Household movement goals (weekly targets, recovery flags).
 * - SessionRunner-ready session drafts (from movement templates).
 *
 * How this fits into SSA:
 * - Logic-heavy calculations live in MovementIntensityCalculator.shim.js
 *   (safe for Web Workers / background automation).
 * - These hooks sit in the React layer and:
 *   - Wrap the shim in a simple `run` helper.
 *   - Convert movement templates → SessionRunner session drafts.
 *   - Derive movement goal signals and emit planning events via eventBus.
 *
 * These hooks are intentionally UI-agnostic: they do not render anything and
 * can be reused across pages, dashboards, and “Now” CTAs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { emit } from "@/services/events/eventBus";
import MovementIntensityCalculatorShim, {
  NODE_ID as MOVEMENT_NODE_ID,
} from "./MovementIntensityCalculator.shim";

/**
 * Generate a simple unique id suitable for local session drafts.
 * (Avoids extra dependencies like uuid for now.)
 * @returns {string}
 */
function generateId() {
  return `sess_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Compute a movement goal status label from guideline-equivalent minutes.
 *
 * @param {number} guidelineTarget
 * @param {number} combinedEqMinutes
 * @returns {"below"|"on-track"|"above"}
 */
function inferGoalStatus(guidelineTarget, combinedEqMinutes) {
  if (!guidelineTarget || guidelineTarget <= 0) return "on-track";
  const ratio = combinedEqMinutes / guidelineTarget;
  if (ratio < 0.7) return "below";
  if (ratio > 1.5) return "above";
  return "on-track";
}

/**
 * Pure helper: Build a SessionRunner-ready movement session draft from a
 * movement template produced by the Movement Intensity Calculator shim.
 *
 * NOTE:
 * - We use a `domain: "movement"` extension; SSA’s session schema may be
 *   updated to include this domain alongside cooking/cleaning/garden/etc.
 *
 * @param {object} template
 * @param {object} [options]
 * @param {string} [options.titlePrefix]
 * @returns {import("@/types").SessionObjectLike}
 */
export function buildMovementSessionFromTemplate(template, options = {}) {
  if (!template || typeof template !== "object") return null;

  const { templateId, title, durationMinutes, intensityCategory, source } =
    template;

  const titlePrefix = options.titlePrefix || "";

  const safeTitle = titlePrefix ? `${titlePrefix.trim()} – ${title}` : title;

  const durationSec = Math.max(5 * 60, (durationMinutes || 0) * 60);

  const nowIso = new Date().toISOString();

  return {
    id: generateId(),
    domain: "movement", // extension domain for movement sessions
    title: safeTitle,
    source: {
      type: source?.type || "movementPlan",
      refId: source?.refId || templateId || null,
    },
    steps: [
      {
        id: `step_${templateId || "movement"}`,
        title: title,
        desc: `Complete a ${
          durationMinutes || "20"
        }-minute ${intensityCategory} movement session (walk, indoor cardio, or similar). Use SSA timers or your own watch to stay on track.`,
        durationSec,
        blockers: [
          // Movement-specific blockers could be added here later
          "weather",
          "equipment",
        ],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes:
            "Focus on steady breathing and sustainable effort. You should be able to say a sentence out loud without gasping.",
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
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Hook: useMovementIntensityCalculator
 *
 * Lightweight wrapper around the MovementIntensityCalculator shim that:
 * - Manages input/result/status/error in React state.
 * - Provides a `run` function to (re)calculate.
 * - Optionally auto-runs when input changes.
 *
 * This hook is UI-agnostic; your view code (dashboard, page, widget) can:
 * - Bind form fields to `input` and `setInput`.
 * - Call `run()` when the user clicks “Calculate”.
 * - Read `result` to render summaries or session templates.
 *
 * @param {object} [options]
 * @param {object} [options.initialInput] - Optional initial input payload.
 * @param {boolean} [options.autoRun=false] - If true, re-run on input changes (debounced).
 * @param {boolean} [options.exportToHubDefault=false] - Default export-to-hub toggle.
 */
export function useMovementIntensityCalculator(options = {}) {
  const {
    initialInput = null,
    autoRun = false,
    exportToHubDefault = false,
  } = options;

  const [input, setInput] = useState(() => initialInput || {});
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("idle"); // "idle" | "running" | "success" | "error"
  const [error, setError] = useState(null);
  const [exportToHub, setExportToHub] = useState(exportToHubDefault);

  const run = useCallback(
    async (overrideInput) => {
      const effectiveInput =
        overrideInput && typeof overrideInput === "object"
          ? overrideInput
          : input;

      setStatus("running");
      setError(null);

      try {
        const payload = await MovementIntensityCalculatorShim.run(
          effectiveInput,
          { exportToHub }
        );

        setResult(payload);
        setStatus("success");

        return payload;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[useMovementIntensityCalculator] calculation failed",
          err
        );
        const message =
          err && err.message
            ? err.message
            : "Movement intensity calculation failed.";
        setError(message);
        setStatus("error");

        emit({
          type: "calculator.movementIntensity.error",
          ts: new Date().toISOString(),
          source:
            "features/calculators/health/MovementIntensityCalculator/MovementIntensityCalculator.hooks",
          data: {
            nodeId: MOVEMENT_NODE_ID,
            error: message,
          },
        });

        throw err;
      }
    },
    [input, exportToHub]
  );

  // Optional auto-run when input changes (for planner dashboards)
  useEffect(() => {
    if (!autoRun) return;
    if (!input || Object.keys(input).length === 0) return;

    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled) return;
      run().catch(() => {
        // error handling already done in run
      });
    }, 400); // small debounce

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [autoRun, input, run]);

  return {
    nodeId: MOVEMENT_NODE_ID,
    input,
    setInput,
    result,
    status,
    error,
    exportToHub,
    setExportToHub,
    run,
  };
}

/**
 * Hook: useMovementSessionDrafts
 *
 * Converts a Movement Intensity Calculator result into:
 * - An array of SessionRunner-ready movement session drafts.
 * - A helper callback to build a single draft from a templateId.
 *
 * This is where we bridge the calculator’s movement templates into
 * your SessionRunner orchestration layer:
 * - Drafts returned here can be pushed into your sessions store.
 * - “Now” CTAs can grab the first draft and feed it into SessionRunner.
 *
 * @param {object|null} calculatorResult - Full payload returned by the shim.
 * @param {object} [options]
 * @param {string} [options.titlePrefix] - Optional prefix for session titles.
 */
export function useMovementSessionDrafts(calculatorResult, options = {}) {
  const { titlePrefix } = options;

  const templates = useMemo(() => {
    if (
      !calculatorResult ||
      !calculatorResult.output ||
      !Array.isArray(calculatorResult.output.movementSessionTemplates)
    ) {
      return [];
    }
    return calculatorResult.output.movementSessionTemplates;
  }, [calculatorResult]);

  const drafts = useMemo(
    () =>
      templates
        .map((tpl) => buildMovementSessionFromTemplate(tpl, { titlePrefix }))
        .filter(Boolean),
    [templates, titlePrefix]
  );

  const buildFromTemplateId = useCallback(
    (templateId) => {
      const tpl = templates.find((t) => t.templateId === templateId);
      if (!tpl) return null;
      return buildMovementSessionFromTemplate(tpl, { titlePrefix });
    },
    [templates, titlePrefix]
  );

  return {
    templates,
    drafts,
    buildFromTemplateId,
  };
}

/**
 * Hook: useMovementGoalSignals
 *
 * Derives high-level goal & planning signals from a Movement Intensity
 * Calculator result and offers a helper to emit a “movement goals updated”
 * planning event.
 *
 * Uses:
 * - Planner dashboards to quickly see if movement is below / on / above target.
 * - Automation runtime to schedule more/less movement sessions.
 *
 * @param {object|null} calculatorResult
 */
export function useMovementGoalSignals(calculatorResult) {
  const goals = useMemo(() => {
    if (
      !calculatorResult ||
      !calculatorResult.output ||
      !calculatorResult.output.movementMinutesTargets
    ) {
      return null;
    }

    const { movementMinutesTargets, recoveryLoadFlags } =
      calculatorResult.output;

    const guidelineTarget =
      movementMinutesTargets.combinedGuidelineEquivalentMinutesPerWeek || 0;
    const deficit = movementMinutesTargets.deficitToGuidelineMinutes || 0;
    const combinedEqMinutes = guidelineTarget - deficit;

    const status = inferGoalStatus(guidelineTarget, combinedEqMinutes);

    return {
      status, // "below" | "on-track" | "above"
      guidelineTargetMinutes: guidelineTarget,
      actualEquivalentMinutes: combinedEqMinutes,
      deficitMinutes: deficit,
      recovery: recoveryLoadFlags || null,
    };
  }, [calculatorResult]);

  const emitGoalUpdate = useCallback(() => {
    if (!goals) return;

    emit({
      type: "planner.movementGoals.updated",
      ts: new Date().toISOString(),
      source:
        "features/calculators/health/MovementIntensityCalculator/MovementIntensityCalculator.hooks",
      data: {
        nodeId: MOVEMENT_NODE_ID,
        goals,
      },
    });
  }, [goals]);

  return {
    goals,
    emitGoalUpdate,
  };
}

/**
 * Default export: grouped hooks and helpers for convenience.
 */
const MovementIntensityCalculatorHooks = {
  useMovementIntensityCalculator,
  useMovementSessionDrafts,
  useMovementGoalSignals,
  buildMovementSessionFromTemplate,
};

export default MovementIntensityCalculatorHooks;
