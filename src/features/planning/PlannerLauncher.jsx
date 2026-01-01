// C:\Users\larho\suka-smart-assistant\src\features\planning\PlannerLauncher.jsx

/**
 * PlannerLauncher
 * ----------------
 * How this fits SSA:
 * - SSA has multiple planner modules (Meal Planner, Garden Planner, Animal Planner,
 *   Cleaning Planner, Storehouse Planner, etc.) that live on different routes.
 * - The Planning Graph represents these as nodes with IDs.
 * - This helper:
 *    • Accepts a nodeId (or node) from the Planning Graph,
 *    • Resolves it to a planner config (route, label, domain),
 *    • Navigates to the correct planner UI OR calls a provided callback,
 *    • Emits a `planning.planner.launch` event via the event bus.
 *
 * Examples:
 *   <PlannerLauncher nodeId="node.mealPlanner" />
 *
 *   <PlannerLauncher
 *     node={node}
 *     variant="secondary"
 *     onLaunch={({ node, config, navigate }) => {
 *       // Custom launch logic, e.g. pre-seeding planner state or query params.
 *       navigate(config.route, {
 *         state: { fromNodeId: node.id, seedFromPlanning: true },
 *       });
 *     }}
 *   />
 *
 * Notes:
 * - This file does NOT own the SessionRunner modal. It’s purely for planner UIs.
 * - Route resolution order:
 *     1) node.meta.plannerRoute (preferred – lives with the node),
 *     2) PLANNER_REGISTRY entry below (central overrides).
 * - Extend PLANNER_REGISTRY as SSA grows.
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
 * @typedef {Object} PlannerConfig
 * @property {string} id                 // planner ID (usually node.id)
 * @property {string} [route]            // route to navigate to
 * @property {string} [title]            // UI label
 * @property {string} [domain]           // domain hint ("cooking"|"garden"|...)
 * @property {string} [icon]             // optional icon name/key
 * @property {Object.<string, any>} [meta]
 */

/**
 * @typedef {"primary"|"secondary"|"ghost"|"link"} PlannerLauncherVariant
 */

/**
 * @typedef {"sm"|"md"|"lg"} PlannerLauncherSize
 */

/**
 * @typedef {Object} PlannerLauncherProps
 * @property {string} [nodeId]                         // Preferred: Planning Graph node id
 * @property {PlanningNode} [node]                    // Optional: pre-resolved node
 * @property {PlannerLauncherVariant} [variant]       // Visual style, default "primary"
 * @property {PlannerLauncherSize} [size]             // "sm"|"md"|"lg"
 * @property {boolean} [fullWidth]                    // If true, stretch button
 * @property {string} [label]                         // Override button label
 * @property {(payload: {
 *   node: PlanningNode,
 *   config: PlannerConfig,
 *   navigate: (to: string, opts?: any) => void,
 *   event: {
 *     type: string,
 *     ts: string,
 *     source: string,
 *     data: any
 *   }
 * }) => void} [onLaunch]                             // Optional custom launch behavior
 * @property {string} [className]
 * @property {string} [dataTestid]
 */

/**
 * Central override for planner routes and metadata.
 *
 * You can keep this empty and rely on node.meta.plannerRoute / plannerTitle /
 * plannerDomain, or populate it for common planners.
 *
 * Example entries (uncomment & adapt to your actual routes):
 *
 * const PLANNER_REGISTRY = Object.freeze({
 *   "node.mealPlanner": {
 *     id: "node.mealPlanner",
 *     route: "/tier2/household/meals/planner",
 *     title: "Meal Planner",
 *     domain: "cooking",
 *   },
 *   "node.gardenPlanner": {
 *     id: "node.gardenPlanner",
 *     route: "/tier2/garden/planner",
 *     title: "Garden Planner",
 *     domain: "garden",
 *   },
 *   "node.animalPlanner": {
 *     id: "node.animalPlanner",
 *     route: "/tier2/animals/planner",
 *     title: "Animal Planner",
 *     domain: "animals",
 *   },
 *   "node.storehousePlanner": {
 *     id: "node.storehousePlanner",
 *     route: "/tier2/storehouse/planner",
 *     title: "Storehouse Planner",
 *     domain: "storehouse",
 *   },
 * });
 */
const PLANNER_REGISTRY = Object.freeze(
  /** @type {Record<string, PlannerConfig>} */
  ({})
);

/**
 * Resolve a planner config from a Planning Graph node.
 * Preference order:
 *   1) node.meta.plannerRoute
 *   2) PLANNER_REGISTRY entry
 *
 * @param {PlanningNode|null} node
 * @returns {PlannerConfig|null}
 */
export function getPlannerConfigForNode(node) {
  if (!node || !node.id) return null;

  const registryMatch = PLANNER_REGISTRY[node.id] || null;

  const routeFromMeta =
    node.meta && typeof node.meta.plannerRoute === "string"
      ? node.meta.plannerRoute
      : null;

  const titleFromMeta =
    node.meta && typeof node.meta.plannerTitle === "string"
      ? node.meta.plannerTitle
      : null;

  const domainFromMeta =
    node.meta && typeof node.meta.plannerDomain === "string"
      ? node.meta.plannerDomain
      : null;

  const route = routeFromMeta || registryMatch?.route || null;

  if (!route && !registryMatch) {
    // Provide a minimal config to help debug missing routes.
    return {
      id: node.id,
      title: node.title || node.id,
      domain: node.domain,
      meta: {
        reason: "No plannerRoute in node.meta and no registry entry.",
      },
    };
  }

  /** @type {PlannerConfig} */
  const config = {
    id: registryMatch?.id || node.id,
    route: route || registryMatch?.route,
    title:
      titleFromMeta ||
      registryMatch?.title ||
      node.title ||
      node.id ||
      "Planner",
    domain: domainFromMeta || registryMatch?.domain || node.domain,
    icon: registryMatch?.icon || node.meta?.plannerIcon || undefined,
    meta: {
      ...registryMatch?.meta,
      ...node.meta,
    },
  };

  return config;
}

/**
 * PlannerLauncher – small button that opens the right planner module
 * based on a Planning Graph node or nodeId.
 *
 * @param {PlannerLauncherProps} props
 */
export function PlannerLauncher(props) {
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

  const config = useMemo(() => getPlannerConfigForNode(node), [node]);

  const disabled = useMemo(() => {
    if (!node || !config) return true;
    // If there is neither a route nor a custom launch handler, disable.
    if (!config.route && typeof onLaunch !== "function") return true;
    return false;
  }, [node, config, onLaunch]);

  const buttonLabel = useMemo(() => {
    if (label) return label;
    if (config && config.title) return config.title;
    if (node && node.title) return `Open ${node.title}`;
    if (node && node.id) return `Open ${node.id}`;
    return "Open Planner";
  }, [label, config, node]);

  const ariaLabel = useMemo(() => {
    if (disabled && !node) {
      return "Planner launcher unavailable. Node is not defined.";
    }
    if (disabled && node && !config?.route && typeof onLaunch !== "function") {
      return "This planner cannot be opened yet. No route or launch handler is configured.";
    }
    return buttonLabel;
  }, [disabled, node, config, onLaunch, buttonLabel]);

  const titleAttr = ariaLabel;

  const variantClass = useMemo(() => {
    switch (variant) {
      case "secondary":
        return "planner-launcher-btn--secondary";
      case "ghost":
        return "planner-launcher-btn--ghost";
      case "link":
        return "planner-launcher-btn--link";
      case "primary":
      default:
        return "planner-launcher-btn--primary";
    }
  }, [variant]);

  const sizeClass = useMemo(() => {
    switch (size) {
      case "sm":
        return "planner-launcher-btn--sm";
      case "lg":
        return "planner-launcher-btn--lg";
      case "md":
      default:
        return "planner-launcher-btn--md";
    }
  }, [size]);

  const fullWidthClass = fullWidth ? "planner-launcher-btn--full" : "";

  const combinedClassName = [
    "planner-launcher-btn",
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
        type: "planning.planner.launch",
        ts,
        source: "features/planning/PlannerLauncher",
        data: {
          nodeId: node.id,
          plannerId: config.id,
          route: config.route || null,
          domain: config.domain || node.domain || null,
          title: config.title || node.title || null,
        },
      };

      try {
        emitEvent(eventPayload);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.error("[PlannerLauncher] Failed to emit event:", err);
        }
      }

      // Custom launch handler overrides default navigation.
      if (typeof onLaunch === "function") {
        onLaunch({
          node,
          config,
          navigate,
          event: eventPayload,
        });
        return;
      }

      // Fallback: direct navigation to the route.
      if (config.route) {
        navigate(config.route, {
          state: {
            fromNodeId: node.id,
            planningNode: node,
            planningLaunchKind: "planner",
          },
        });
      } else if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[PlannerLauncher] No route configured for planner:",
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
      {/* Optional icon placeholder: style via ::before or add an icon prop later */}
      <span className="planner-launcher-btn__label">{buttonLabel}</span>
    </button>
  );
}

export default PlannerLauncher;
