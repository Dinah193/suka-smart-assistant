// C:\Users\larho\suka-smart-assistant\src\features\planning\helpers\nextStepsStrategies.js
// =============================================================================
// Planning Graph — Domain Next Steps Strategies
// -----------------------------------------------------------------------------
// Purpose:
//   Strategy functions that define how to choose "Next Steps" per domain
//   (cooking, cleaning, garden, animals, preservation, storehouse).
//
//   These strategies sit on top of mappingResolvers.resolveNextSteps(...) and
//   apply domain-specific prioritization and filtering logic.
//
// How this fits into SSA:
//   • Used by:
//       - Session shims (e.g. after a cooking session finishes, suggest the
//         next calculator or planner).
//       - Domain pages' "Now" CTA logic (what else should the user run?).
//       - Planning Graph UI panels that show "Next recommended tools".
//   • All strategies are pure and side-effect free. They only decide WHAT to
//     suggest, not HOW to launch it (SessionRunner takes over after selection).
//
// Design:
//   • Each domain has a small strategy function that:
//        - Calls resolveNextSteps(...) (global + node-specific + graph).
//        - Reorders results to prefer in-domain steps first.
//        - Optionally limits result count differently per domain.
//   • A default strategy is used when no domain-specific strategy exists.
//   • Main entrypoint: selectNextStepsForNode(node, context)
//
// Extension points:
//   • Add new domains (e.g. "homestead") by adding a new strategy function and
//     wiring it into DOMAIN_STRATEGIES.
//   • Use userPrefs (e.g. preferPlannersFirst) to tweak ranking further.
//   • Future: pass currentSession, time-of-day, or household flags into
//     strategies to make them even smarter.
// =============================================================================

import { resolveNextSteps } from "./mappingResolvers";

/**
 * @typedef {Object} PlanningNode
 * @property {string} id
 * @property {string} title
 * @property {string} domain
 * @property {string} [nodeType]
 * @property {string[]} [tags]
 * @property {string[]} [feedsInto]
 * @property {string[]} [dependsOn]
 * @property {Object}  [meta]
 */

/**
 * @typedef {Object} ResolvedNextStep
 * @property {string} sourceNodeId
 * @property {string} targetId
 * @property {string} label
 * @property {string} [reason]
 * @property {number} priority
 * @property {string[]} tags
 * @property {"node-specific" | "global" | "graph"} origin
 * @property {boolean} [autoStartSession]
 * @property {string} domain
 */

/**
 * @typedef {Object} UserNextStepsPrefs
 * @property {boolean} [preferCalculatorsFirst]
 * @property {boolean} [preferPlannersFirst]
 * @property {string[]} [enabledDomains]   // optional allow-list for cross-domain steps
 */

/**
 * @typedef {Object} GlobalMappings
 * @property {any} [defaults]
 * @property {Record<string, any[]>} [byDomain]
 * @property {Record<string, any[]>} [byNodeType]
 */

/**
 * @typedef {Object} NextStepsContext
 * @property {PlanningNode[]} allNodes
 * @property {GlobalMappings | null | undefined} [globalMappings]
 * @property {boolean} [includeGraph]       // default true
 * @property {number} [maxResults]          // hard cap if provided
 * @property {UserNextStepsPrefs} [userPrefs]
 * @property {any} [currentSession]         // optional; reserved for future use
 */

/**
 * @typedef {Object} NextStepsSelection
 * @property {ResolvedNextStep | null} primary
 * @property {ResolvedNextStep[]} secondary
 * @property {ResolvedNextStep[]} all
 */

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 5;

/**
 * @param {string | null | undefined} v
 * @returns {string}
 */
function normalizeLower(v) {
  return typeof v === "string" ? v.toLowerCase() : "";
}

/**
 * Build a selection object from a flat list, with optional result cap.
 * The list is assumed to be ordered from best → worst.
 *
 * @param {ResolvedNextStep[]} steps
 * @param {number | undefined} cap
 * @returns {NextStepsSelection}
 */
function buildSelection(steps, cap) {
  const limit =
    typeof cap === "number" && cap > 0
      ? cap
      : steps.length;

  const sliced = steps.slice(0, limit);
  const primary = sliced.length ? sliced[0] : null;
  const secondary = primary ? sliced.slice(1) : [];

  return {
    primary,
    secondary,
    all: sliced,
  };
}

/**
 * Apply user preference tweaks (non-destructive) to an already-sorted list.
 * This is intentionally subtle: we don't fully re-rank, just nudge.
 *
 * @param {ResolvedNextStep[]} steps
 * @param {UserNextStepsPrefs | undefined} prefs
 * @returns {ResolvedNextStep[]}
 */
function applyUserPrefs(steps, prefs) {
  if (!prefs || !steps.length) return steps;

  const { preferCalculatorsFirst, preferPlannersFirst, enabledDomains } = prefs;

  const hasDomainAllowList = Array.isArray(enabledDomains) && enabledDomains.length > 0;
  const domainAllowSet = hasDomainAllowList
    ? new Set(enabledDomains.map((d) => normalizeLower(d)).filter(Boolean))
    : null;

  /**
   * Small scoring function layered on top of the existing ordering.
   * Higher score = better.
   *
   * We treat tags as soft hints here (e.g. ["planner","calculator"]).
   */
  const scoreStep = (step, index) => {
    let score = 0;

    const lowerTags = (step.tags || []).map((t) => normalizeLower(t));

    if (preferCalculatorsFirst && lowerTags.includes("calculator")) {
      score += 2;
    }

    if (preferPlannersFirst && lowerTags.includes("planner")) {
      score += 2;
    }

    // Very gentle penalty for being far down the original list
    score -= index * 0.01;

    // If domain allow-list exists, strongly penalize disabled domains
    if (domainAllowSet && !domainAllowSet.has(normalizeLower(step.domain))) {
      score -= 5;
    }

    return score;
  };

  const withScores = steps.map((s, idx) => ({
    step: s,
    score: scoreStep(s, idx),
    originalIndex: idx,
  }));

  withScores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  return withScores.map((x) => x.step);
}

// -----------------------------------------------------------------------------
// Core "base" strategy
// -----------------------------------------------------------------------------

/**
 * Base strategy used by all domain-specific strategies:
 *   1) Calls resolveNextSteps(...)
 *   2) Orders in-domain results first, then cross-domain results.
 *   3) Applies userPrefs tweaks.
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @param {{ defaultMaxResults?: number }} [options]
 * @returns {NextStepsSelection}
 */
function baseDomainStrategy(node, context, options = {}) {
  if (!node || !node.id) {
    return { primary: null, secondary: [], all: [] };
  }

  const {
    allNodes,
    globalMappings,
    includeGraph = true,
    maxResults,
    userPrefs,
  } = context || {};

  const effectiveCap =
    typeof maxResults === "number" && maxResults > 0
      ? maxResults
      : (options.defaultMaxResults || DEFAULT_MAX_RESULTS);

  const allResolved = resolveNextSteps(node, {
    allNodes: allNodes || [],
    globalMappings: globalMappings || null,
    includeGraph,
    maxResults: effectiveCap * 2, // gather extra, we'll trim later
  });

  if (!allResolved.length) {
    return { primary: null, secondary: [], all: [] };
  }

  const ownDomain = normalizeLower(node.domain);

  const inDomain = [];
  const crossDomain = [];

  for (const step of allResolved) {
    if (normalizeLower(step.domain) === ownDomain) {
      inDomain.push(step);
    } else {
      crossDomain.push(step);
    }
  }

  // In-domain first, then cross-domain
  const ordered = [...inDomain, ...crossDomain];

  // Apply user preference nudges
  const tuned = applyUserPrefs(ordered, userPrefs);

  // Final cap and selection
  return buildSelection(tuned, effectiveCap);
}

// -----------------------------------------------------------------------------
// Domain-specific strategies
// -----------------------------------------------------------------------------

/**
 * Cooking domain strategy:
 *   - Focus on in-domain first (macros, recipe planners, batch tools).
 *   - Reasonable cap: 4 results (primary + a few alternates).
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
function cookingStrategy(node, context) {
  return baseDomainStrategy(node, context, {
    defaultMaxResults: 4,
  });
}

/**
 * Cleaning domain strategy:
 *   - Focus on in-domain steps.
 *   - Allow cross-domain steps from "storehouse" or "preservation" to
 *     suggest stocking or maintenance tools.
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
function cleaningStrategy(node, context) {
  // For now this mirrors the base behavior; cross-domain allowances can be
  // tuned via context.userPrefs.enabledDomains if desired.
  return baseDomainStrategy(node, context, {
    defaultMaxResults: 3,
  });
}

/**
 * Garden domain strategy:
 *   - In-domain first (seed/plant planners, harvest loggers).
 *   - Cross-domain "storehouse" suggestions (preservation, inventory) are
 *     particularly relevant after harvest-related nodes.
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
function gardenStrategy(node, context) {
  return baseDomainStrategy(node, context, {
    defaultMaxResults: 5,
  });
}

/**
 * Animals domain strategy:
 *   - In-domain first (care, breeding, butchery planning).
 *   - Cross-domain "storehouse" and "preservation" suggestions can be
 *     helpful after butchery/meat calculators.
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
function animalsStrategy(node, context) {
  return baseDomainStrategy(node, context, {
    defaultMaxResults: 5,
  });
}

/**
 * Preservation domain strategy:
 *   - In-domain first (canning, freezing, dehydrating, curing).
 *   - Cross-domain "storehouse" steps (inventory updates, meal planning)
 *     are highly relevant.
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
function preservationStrategy(node, context) {
  return baseDomainStrategy(node, context, {
    defaultMaxResults: 4,
  });
}

/**
 * Storehouse domain strategy:
 *   - In-domain (inventory, macro calculators, storehouse meal planning).
 *   - Cross-domain cooking/garden/animals suggestions can follow after
 *     planning sessions (e.g. "Now cook from this plan").
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
function storehouseStrategy(node, context) {
  return baseDomainStrategy(node, context, {
    defaultMaxResults: 6,
  });
}

/**
 * Default strategy for unknown or new domains:
 *   - Uses baseDomainStrategy with a sensible default cap.
 *
 * @param {PlanningNode} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
function defaultStrategy(node, context) {
  return baseDomainStrategy(node, context, {
    defaultMaxResults: DEFAULT_MAX_RESULTS,
  });
}

// -----------------------------------------------------------------------------
// Strategy registry & public API
// -----------------------------------------------------------------------------

/** @type {Record<string, (node: PlanningNode, context: NextStepsContext) => NextStepsSelection>} */
const DOMAIN_STRATEGIES = {
  cooking: cookingStrategy,
  cleaning: cleaningStrategy,
  garden: gardenStrategy,
  animals: animalsStrategy,
  preservation: preservationStrategy,
  storehouse: storehouseStrategy,
};

/**
 * Get the strategy function for a given domain.
 * Falls back to defaultStrategy if domain is unknown.
 *
 * @param {string} domain
 * @returns {(node: PlanningNode, context: NextStepsContext) => NextStepsSelection}
 */
export function getDomainStrategy(domain) {
  const key = normalizeLower(domain);
  return DOMAIN_STRATEGIES[key] || defaultStrategy;
}

/**
 * Main entrypoint:
 *   Select Next Steps for a node using the appropriate domain strategy.
 *
 * Usage:
 *   const selection = selectNextStepsForNode(currentNode, {
 *     allNodes,
 *     globalMappings,
 *     includeGraph: true,
 *     userPrefs: {
 *       preferPlannersFirst: true,
 *       enabledDomains: ["cooking", "storehouse"],
 *     },
 *   });
 *
 *   // selection.primary -> main CTA
 *   // selection.secondary -> "More options" list
 *   // selection.all -> full capped list
 *
 * @param {PlanningNode | null | undefined} node
 * @param {NextStepsContext} context
 * @returns {NextStepsSelection}
 */
export function selectNextStepsForNode(node, context) {
  if (!node || !node.id) {
    return { primary: null, secondary: [], all: [] };
  }
  const strategy = getDomainStrategy(node.domain);
  return strategy(node, context);
}

/**
 * Optional helper for components that only have a nodeId and domain string.
 *
 * The caller is responsible for resolving the node object; this helper exists
 * mainly to keep component code tidy.
 *
 * @param {string} nodeId
 * @param {string} domain
 * @param {NextStepsContext & { findNodeById: (id: string) => PlanningNode | null }} context
 * @returns {NextStepsSelection}
 */
export function selectNextStepsByNodeId(nodeId, domain, context) {
  const { findNodeById: lookup } = context || {};
  if (typeof lookup !== "function") {
    return { primary: null, secondary: [], all: [] };
  }
  const node = lookup(nodeId);
  if (!node) {
    // Fallback: construct a minimal node with the given domain.
    /** @type {PlanningNode} */
    const syntheticNode = {
      id: nodeId,
      title: nodeId,
      domain,
    };
    const strategy = getDomainStrategy(domain);
    return strategy(syntheticNode, context);
  }
  return selectNextStepsForNode(node, context);
}

// Default export: convenient bundle for imports
const nextStepsStrategies = {
  selectNextStepsForNode,
  selectNextStepsByNodeId,
  getDomainStrategy,
  DOMAIN_STRATEGIES,
};

export default nextStepsStrategies;
