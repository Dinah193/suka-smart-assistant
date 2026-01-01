// C:\Users\larho\suka-smart-assistant\src\features\planning\CalculatorLauncher.jsx

/**
 * CalculatorLauncher
 * ------------------
 * How this fits SSA:
 * - SSA has many calculators and planners (macro calculator, hair nutrition,
 *   seed viability, storehouse goals, etc.) that live on different routes.
 * - The Planning Graph uses node IDs to represent these tools.
 * - This component is a small helper that:
 *    • Takes a nodeId (or node) from the Planning Graph,
 *    • Resolves it to a calculator config (route, label, domain),
 *    • Navigates to the correct calculator UI OR calls a callback,
 *    • Emits a planning.calculator.launch event via the event bus.
 *
 * Usage:
 *   <CalculatorLauncher
 *     nodeId="node.macroCalculator"
 *     variant="secondary"
 *     size="sm"
 *   />
 *
 *   // Or with explicit callback:
 *   <CalculatorLauncher
 *     node={node}
 *     onLaunch={(payload) => {
 *       // payload.node, payload.config, payload.navigate, payload.event
 *       payload.navigate(payload.config.route);
 *     }}
 *   />
 *
 * Notes:
 * - This file does not own the SessionRunner. It’s purely for UI calculators.
 * - Route paths can be specified in:
 *     1) node.meta.calculatorRoute (preferred — lives with the node), or
 *     2) CALCULATOR_REGISTRY below (central override).
 * - Extend CALCULATOR_REGISTRY as your SSA grows.
 */

/* eslint-disable no-console */

import React, { useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { usePlanningGraph } from "./usePlanningGraph";
// Event bus contract: emit({ type, ts, source, data })
import { emit as emitEvent } from "@/services/eventBus";

/**
 * @typedef {import("./usePlanningGraph").PlanningNode} PlanningNode
 */

/**
 * @typedef {Object} CalculatorConfig
 * @property {string} id                 // calculator ID (usually node.id)
 * @property {string} [route]            // route to navigate to
 * @property {string} [title]            // UI label
 * @property {string} [domain]           // domain hint
 * @property {string} [icon]             // optional icon name/key
 * @property {Object.<string, any>} [meta]
 */

/**
 * @typedef {"primary"|"secondary"|"ghost"|"link"} CalculatorLauncherVariant
 */

/**
 * @typedef {"sm"|"md"|"lg"} CalculatorLauncherSize
 */

/**
 * @typedef {Object} CalculatorLauncherProps
 * @property {string} [nodeId]                         // Preferred: Planning Graph node id
 * @property {PlanningNode} [node]                    // Optional: pre-resolved node
 * @property {CalculatorLauncherVariant} [variant]    // Visual style, defaults to "primary"
 * @property {CalculatorLauncherSize} [size]          // "sm"|"md"|"lg"
 * @property {boolean} [fullWidth]                    // If true, stretch button
 * @property {string} [label]                         // Override button label
 * @property {(payload: {
 *   node: PlanningNode,
 *   config: CalculatorConfig,
 *   navigate: (to: string) => void,
 *   event: {
 *     type: string,
 *     ts: string,
 *     source: string,
 *     data: any
 *   }
 * }) => void} [onLaunch]                             // Optional: override launch behavior
 * @property {string} [className]
 * @property {string} [dataTestid]
 */

/**
 * Central override for calculator routes and metadata.
 * - You can keep this empty and rely on node.meta.calculatorRoute,
 *   or populate it for shared/common calculators.
 *
 * Example entries (uncomment & adjust as your routes solidify):
 *
 * const CALCULATOR_REGISTRY = Object.freeze({
 *   "node.macroCalculator": {
 *     id: "node.macroCalculator",
 *     route: "/tier2/health/macro-calculator",
 *     title: "Daily Macro Calculator",
 *     domain: "cooking",
 *   },
 *   "node.seedViabilityCalculator": {
 *     id: "node.seedViabilityCalculator",
 *     route: "/tier2/garden/seed-viability",
 *     title: "Seed Viability Calculator",
 *     domain: "garden",
 *   },
 * });
 */
const CALCULATOR_REGISTRY = Object.freeze(
  /** @type {Record<string, CalculatorConfig>} */
  ({})
);

/**
 * Resolve a calculator config from a Planning Graph node.
 * Preference order:
 *   1) node.meta.calculatorRoute
 *   2) CALCULATOR_REGISTRY entry
 *
 * @param {PlanningNode|null} node
 * @returns {CalculatorConfig|null}
 */
export function getCalculatorConfigForNode(node) {
  if (!node || !node.id) return null;

  const registryMatch = CALCULATOR_REGISTRY[node.id] || null;

  // Preferred: route declared directly on the node meta.
  const routeFromMeta =
    node.meta && typeof node.meta.calculatorRoute === "string"
      ? node.meta.calculatorRoute
      : null;

  const titleFromMeta =
    node.meta && typeof node.meta.calculatorTitle === "string"
      ? node.meta.calculatorTitle
      : null;

  const domainFromMeta =
    node.meta && typeof node.meta.calculatorDomain === "string"
      ? node.meta.calculatorDomain
      : null;

  // Compose config from the strongest available hints.
  const route = routeFromMeta || registryMatch?.route || null;

  if (!route && !registryMatch) {
    // If we truly have nothing, return a minimal config that makes debugging easier.
    return {
      id: node.id,
      title: node.title || node.id,
      domain: node.domain,
      meta: {
        reason: "No calculatorRoute in node.meta and no registry entry.",
      },
    };
  }

  /** @type {CalculatorConfig} */
  const config = {
    id: registryMatch?.id || node.id,
    route: route || registryMatch?.route,
    title:
      titleFromMeta ||
      registryMatch?.title ||
      node.title ||
      node.id ||
      "Calculator",
    domain: domainFromMeta || registryMatch?.domain || node.domain,
    icon: registryMatch?.icon || node.meta?.calculatorIcon || undefined,
    meta: {
      ...registryMatch?.meta,
      ...node.meta,
    },
  };

  return config;
}

/**
 * CalculatorLauncher – small button that opens the right calculator UI
 * based on a Planning Graph node or nodeId.
 *
 * @param {CalculatorLauncherProps} props
 */
export function CalculatorLauncher(props) {
  const {
    nodeId,
    node: rawNode,
    variant = "primary",
    size = "md",
    fullWidth = false,
    label,
    onLaunch,
    className = "",
    dataTestid,
  } = props || {};

  const navigate = useNavigate();
  const { getNodeById } = usePlanningGraph();

  /** @type {PlanningNode|null} */
  const node = useMemo(() => {
    if (rawNode && typeof rawNode.id === "string") return rawNode;
    if (nodeId) return getNodeById(nodeId);
    return null;
  }, [rawNode, nodeId, getNodeById]);

  const config = useMemo(() => getCalculatorConfigForNode(node), [node]);

  const disabled = useMemo(() => {
    if (!node || !config) return true;
    // If there is neither a route nor an external launch handler, disable.
    if (!config.route && typeof onLaunch !== "function") return true;
    return false;
  }, [node, config, onLaunch]);

  const buttonLabel = useMemo(() => {
    if (label) return label;
    if (config && config.title) return config.title;
    if (node && node.title) return `Open ${node.title}`;
    if (node && node.id) return `Open ${node.id}`;
    return "Open Calculator";
  }, [label, config, node]);

  const ariaLabel = useMemo(() => {
    if (disabled && !node) {
      return "Calculator launcher unavailable. Node is not defined.";
    }
    if (disabled && node && !config?.route && typeof onLaunch !== "function") {
      return "This calculator cannot be opened yet. No route or launch handler is configured.";
    }
    return buttonLabel;
  }, [disabled, node, config, onLaunch, buttonLabel]);

  const titleAttr = ariaLabel;

  const variantClass = useMemo(() => {
    switch (variant) {
      case "secondary":
        return "calculator-launcher-btn--secondary";
      case "ghost":
        return "calculator-launcher-btn--ghost";
      case "link":
        return "calculator-launcher-btn--link";
      case "primary":
      default:
        return "calculator-launcher-btn--primary";
    }
  }, [variant]);

  const sizeClass = useMemo(() => {
    switch (size) {
      case "sm":
        return "calculator-launcher-btn--sm";
      case "lg":
        return "calculator-launcher-btn--lg";
      case "md":
      default:
        return "calculator-launcher-btn--md";
    }
  }, [size]);

  const fullWidthClass = fullWidth ? "calculator-launcher-btn--full" : "";

  const combinedClassName = [
    "calculator-launcher-btn",
    variantClass,
    sizeClass,
    fullWidthClass,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const handleClick = useCallback(
    (evt) => {
      evt.preventDefault();
      if (disabled || !node || !config) return;

      const ts = new Date().toISOString();

      const eventPayload = {
        type: "planning.calculator.launch",
        ts,
        source: "features/planning/CalculatorLauncher",
        data: {
          nodeId: node.id,
          calculatorId: config.id,
          route: config.route || null,
          domain: config.domain || node.domain || null,
          title: config.title || node.title || null,
        },
      };

      try {
        emitEvent(eventPayload);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.error("[CalculatorLauncher] Failed to emit event:", err);
        }
      }

      // If a custom onLaunch handler is provided, use it and let it decide
      // whether/how to call navigate.
      if (typeof onLaunch === "function") {
        onLaunch({
          node,
          config,
          navigate,
          event: eventPayload,
        });
        return;
      }

      // Fallback: direct navigation if route exists.
      if (config.route) {
        navigate(config.route, {
          state: {
            fromNodeId: node.id,
            planningNode: node,
          },
        });
      } else if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[CalculatorLauncher] No route configured for calculator:",
          config
        );
      }
    },
    [disabled, node, config, onLaunch, navigate]
  );

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
      {/* Icon space: style with ::before or plug in an icon system later */}
      <span className="calculator-launcher-btn__label">{buttonLabel}</span>
    </button>
  );
}

export default CalculatorLauncher;
