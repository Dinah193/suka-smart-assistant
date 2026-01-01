// C:\Users\larho\suka-smart-assistant\src\features\planning\NextStepsActionButton.jsx

/**
 * NextStepsActionButton
 * ---------------------
 * How this fits SSA:
 * - This is a small, reusable button component for firing individual
 *   “recommended actions” from the Planning Graph / Next Steps system.
 * - It’s intentionally dumb about SessionRunner and routing. Parents pass
 *   in callbacks:
 *     • onLaunchSession(session)  → open the SessionRunner modal at the app root.
 *     • onOpenNode(node)         → navigate to the appropriate planner/calculator.
 *
 * Typical usages:
 * - Inside NextStepsPanel cards:
 *     <NextStepsActionButton
 *       recommendation={rec}
 *       mode="session"
 *       onLaunchSession={handleLaunchSession}
 *       onOpenNode={handleOpenNode}
 *     />
 *
 * - On domain dashboards as a compact “Play Now” pill.
 *
 * Design:
 * - Supports several visual variants and sizes but leaves actual styling to
 *   CSS classes (no inline design system assumptions).
 * - Defensive: if there is no runnable session or node, the button disables
 *   itself and explains why via aria-label + tooltip text (title attr).
 */

/* eslint-disable no-console */

import React, { useMemo, useCallback } from "react";

/**
 * @typedef {import("./useNextSteps").NextStepRecommendation} NextStepRecommendation
 */

/**
 * @typedef {"session"|"planner"|"auto"} NextStepsActionMode
 */

/**
 * @typedef {"primary"|"secondary"|"ghost"|"link"|"icon"} NextStepsActionVariant
 */

/**
 * @typedef {"sm"|"md"|"lg"} NextStepsActionSize
 */

/**
 * @typedef {Object} NextStepsActionButtonProps
 * @property {NextStepRecommendation} recommendation
 * @property {NextStepsActionMode} [mode]       // "auto" chooses session if available, else planner
 * @property {NextStepsActionVariant} [variant] // visual style
 * @property {NextStepsActionSize} [size]
 * @property {string} [childrenLabel]           // optional override label text
 * @property {(session: import("./useNextSteps").SessionLike) => void} [onLaunchSession]
 * @property {(node: import("./usePlanningGraph").PlanningNode) => void} [onOpenNode]
 * @property {boolean} [fullWidth]
 * @property {string} [className]
 * @property {string} [dataTestid]
 */

/**
 * Pick the effective mode given a recommendation and declared mode.
 *
 * @param {NextStepRecommendation} rec
 * @param {NextStepsActionMode|undefined} declaredMode
 * @returns {"session"|"planner"|"none"}
 */
function resolveMode(rec, declaredMode) {
  const requested = declaredMode || "auto";

  if (requested === "session") {
    return rec?.primarySession ? "session" : "none";
  }

  if (requested === "planner") {
    return rec?.node ? "planner" : "none";
  }

  // "auto"
  if (rec?.primarySession) return "session";
  if (rec?.node) return "planner";
  return "none";
}

/**
 * Derive a sensible default label for the button based on mode, rec, and context.
 *
 * @param {NextStepRecommendation} rec
 * @param {"session"|"planner"|"none"} mode
 * @returns {string}
 */
function deriveDefaultLabel(rec, mode) {
  if (mode === "session") {
    if (rec?.primarySession?.status === "paused") return "Resume Session";
    return "Play Session Now";
  }
  if (mode === "planner") {
    return "Open Planner";
  }
  return "Unavailable";
}

/**
 * Core reusable button component.
 *
 * @param {NextStepsActionButtonProps} props
 */
export function NextStepsActionButton(props) {
  const {
    recommendation,
    mode: declaredMode,
    variant = "primary",
    size = "md",
    childrenLabel,
    onLaunchSession,
    onOpenNode,
    fullWidth = false,
    className = "",
    dataTestid,
  } = props || {};

  const { effectiveMode, label, disabled, ariaLabel, titleAttr } = useMemo(() => {
    /** @type {NextStepRecommendation|null} */
    const rec = recommendation || null;
    const mode = resolveMode(rec, declaredMode);

    if (!rec || mode === "none") {
      return {
        effectiveMode: "none",
        label: childrenLabel || "Unavailable",
        disabled: true,
        ariaLabel:
          "This recommended action is currently unavailable. There is no runnable session or planner associated.",
        titleAttr:
          "No runnable session or planner found for this recommendation.",
      };
    }

    const defaultLabel = deriveDefaultLabel(rec, mode);
    const finalLabel = childrenLabel || defaultLabel;

    let disabled = false;
    let ariaLabel = finalLabel;
    let titleAttr = finalLabel;

    // Basic guard: if mode requires something that isn't present, disable.
    if (mode === "session" && !rec.primarySession) {
      disabled = true;
      ariaLabel =
        "This recommended action is unavailable. No runnable session associated.";
      titleAttr = "No runnable session associated with this recommendation.";
    } else if (mode === "planner" && !rec.node) {
      disabled = true;
      ariaLabel =
        "This recommended action is unavailable. No planner associated.";
      titleAttr = "No planner associated with this recommendation.";
    }

    return {
      effectiveMode: mode,
      label: finalLabel,
      disabled,
      ariaLabel,
      titleAttr,
    };
  }, [recommendation, declaredMode, childrenLabel]);

  const handleClick = useCallback(
    (evt) => {
      evt.preventDefault();
      if (disabled || !recommendation) return;

      if (effectiveMode === "session") {
        if (!recommendation.primarySession) return;
        if (typeof onLaunchSession === "function") {
          onLaunchSession(recommendation.primarySession);
        } else if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[NextStepsActionButton] onLaunchSession not provided; session:",
            recommendation.primarySession
          );
        }
        return;
      }

      if (effectiveMode === "planner") {
        if (!recommendation.node) return;
        if (typeof onOpenNode === "function") {
          onOpenNode(recommendation.node);
        } else if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[NextStepsActionButton] onOpenNode not provided; node:",
            recommendation.node
          );
        }
      }
    },
    [disabled, recommendation, effectiveMode, onLaunchSession, onOpenNode]
  );

  const variantClass = useMemo(() => {
    switch (variant) {
      case "secondary":
        return "next-steps-action-btn--secondary";
      case "ghost":
        return "next-steps-action-btn--ghost";
      case "link":
        return "next-steps-action-btn--link";
      case "icon":
        return "next-steps-action-btn--icon";
      case "primary":
      default:
        return "next-steps-action-btn--primary";
    }
  }, [variant]);

  const sizeClass = useMemo(() => {
    switch (size) {
      case "sm":
        return "next-steps-action-btn--sm";
      case "lg":
        return "next-steps-action-btn--lg";
      case "md":
      default:
        return "next-steps-action-btn--md";
    }
  }, [size]);

  const fullWidthClass = fullWidth ? "next-steps-action-btn--full" : "";

  const combinedClassName = [
    "next-steps-action-btn",
    variantClass,
    sizeClass,
    fullWidthClass,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={combinedClassName}
      disabled={disabled}
      onClick={handleClick}
      aria-label={ariaLabel}
      title={titleAttr}
      data-testid={dataTestid}
    >
      {/* You can optionally add an icon via CSS ::before or a separate prop later. */}
      <span className="next-steps-action-btn__label">{label}</span>
    </button>
  );
}

export default NextStepsActionButton;
