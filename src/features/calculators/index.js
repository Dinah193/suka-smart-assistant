// src/features/calculators/index.js

/**
 * Suka Smart Assistant (SSA) – Calculators Registry
 * ---------------------------------------------------------------------------
 * HOW THIS FITS:
 * - This file is the SINGLE entry point for all calculator-related exports.
 * - Other parts of SSA (dashboards, routers, SessionRunner, planners) should
 *   import from here instead of reaching into individual files.
 *
 * Provides:
 *   - Registry access by calculatorId and planningGraph nodeId.
 *   - Domain-level grouping helpers.
 *   - React context/provider + hooks for calculator state.
 *
 * Example usage:
 *   import {
 *     getCalculatorById,
 *     getCalculatorsByDomain,
 *     CalculatorProvider,
 *     useCalculator
 *   } from "@/features/calculators";
 */

// Core metadata & helper functions
import {
  CALCULATOR_DOMAINS,
  CALCULATOR_TYPES,
  CALCULATOR_LIST,
  CALCULATORS_BY_DOMAIN,
  getCalculatorConfig,
  getCalculatorsByDomain as _getCalculatorsByDomain,
  findCalculatorByNodeId as _findCalculatorByNodeId,
  getDomainForNodeId as _getDomainForNodeId,
  isKnownCalculatorDomain
} from "./calculatorTypes";

// React context / provider / hooks
import {
  CalculatorProvider,
  useCalculatorContext,
  useCalculator
} from "./calculatorContext";

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/**
 * Get the full calculator registry object.
 * Keys are calculatorIds, values are CalculatorTypeConfig objects.
 *
 * NOTE:
 * - This is read-only; treat it as immutable.
 *
 * @returns {{[id: string]: import("./calculatorTypes").CalculatorTypeConfig}}
 */
export function getCalculatorRegistry() {
  return CALCULATOR_TYPES;
}

/**
 * Get a calculator config by its id.
 *
 * @param {string} calculatorId
 * @returns {import("./calculatorTypes").CalculatorTypeConfig | undefined}
 */
export function getCalculatorById(calculatorId) {
  return getCalculatorConfig(calculatorId);
}

/**
 * Get a calculator config by Planning Graph nodeId.
 *
 * @param {string} nodeId e.g. "node.health.bmi"
 * @returns {import("./calculatorTypes").CalculatorTypeConfig | undefined}
 */
export function getCalculatorByNodeId(nodeId) {
  return _findCalculatorByNodeId(nodeId);
}

/**
 * Get calculators associated with a given domain.
 *
 * @param {string} domainId One of CALCULATOR_DOMAINS.*
 * @returns {import("./calculatorTypes").CalculatorTypeConfig[]}
 */
export function getCalculatorsByDomain(domainId) {
  return _getCalculatorsByDomain(domainId);
}

/**
 * Resolve the calculator domain id for a given Planning Graph node id.
 *
 * @param {string} nodeId
 * @returns {string | undefined}
 */
export function getCalculatorDomainForNodeId(nodeId) {
  return _getDomainForNodeId(nodeId);
}

/**
 * Get a flat list of all calculator configs.
 *
 * @returns {import("./calculatorTypes").CalculatorTypeConfig[]}
 */
export function listAllCalculators() {
  return CALCULATOR_LIST;
}

/**
 * Get a precomputed map of domain → calculators in that domain.
 *
 * @returns {{[domain: string]: import("./calculatorTypes").CalculatorTypeConfig[]}}
 */
export function getCalculatorsGroupedByDomain() {
  return CALCULATORS_BY_DOMAIN;
}

// ---------------------------------------------------------------------------
// Re-exports: domains, types, hooks, provider
// ---------------------------------------------------------------------------

export {
  // Domains & constants
  CALCULATOR_DOMAINS,
  CALCULATOR_TYPES,
  CALCULATOR_LIST,
  CALCULATORS_BY_DOMAIN,
  isKnownCalculatorDomain,

  // React context & hooks
  CalculatorProvider,
  useCalculatorContext,
  useCalculator
};

/**
 * DEFAULT EXPORT
 * ---------------------------------------------------------------------------
 * For convenience, the default export is the calculator registry. This is
 * handy for quick lookups in non-typed code:
 *
 *   import calculators from "@/features/calculators";
 *   const bmiConfig = calculators.BMI;
 */
export default CALCULATOR_TYPES;
