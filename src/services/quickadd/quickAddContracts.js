/* eslint-disable no-console */
// src/services/quickadd/quickAddContracts.js

/**
 * AutoDetectedDomain
 * @typedef {"cooking"|"cleaning"|"garden"|"animals"|"inventory"|"nutrition"|"unknown"} AutoDetectedDomain
 */

/**
 * ConfidenceScore (0..1)
 * @typedef {number} ConfidenceScore
 */

/**
 * QuickAddDraft
 * @typedef {Object} QuickAddDraft
 * @property {string} id
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string=} householdId
 * @property {string=} personId
 * @property {string} rawText
 * @property {AutoDetectedDomain} detectedDomain
 * @property {ConfidenceScore} confidence
 * @property {QuickAddSuggestion=} suggestion
 * @property {Object=} confirmedFields
 * @property {string=} status  // "draft" | "committed" | "error"
 * @property {string=} error
 * @property {string=} source  // page/module that opened it
 */

/**
 * QuickAddSuggestion
 * @typedef {Object} QuickAddSuggestion
 * @property {AutoDetectedDomain} domain
 * @property {ConfidenceScore} confidence
 * @property {string} label            // UI label "Inventory item", "Cleaning task", etc.
 * @property {string[]} chips          // “confirm chips” for minimal typing
 * @property {Object} fields           // structured default fields (editable via chips)
 * @property {string[]=} warnings
 * @property {string[]=} errors
 */

/**
 * Event payload: quickadd.opened
 * @typedef {Object} QuickAddOpenedPayload
 * @property {string} at
 * @property {string=} source
 * @property {string=} initialText
 * @property {string=} householdId
 * @property {string=} personId
 */

/**
 * Event payload: quickadd.detected
 * @typedef {Object} QuickAddDetectedPayload
 * @property {string} at
 * @property {AutoDetectedDomain} domain
 * @property {ConfidenceScore} confidence
 * @property {QuickAddSuggestion} suggestion
 * @property {QuickAddDraft} draft
 */

/**
 * Event payload: quickadd.committed
 * @typedef {Object} QuickAddCommittedPayload
 * @property {string} at
 * @property {AutoDetectedDomain} domain
 * @property {QuickAddDraft} draft
 * @property {Object} entity
 */
export const QUICKADD_EVENTS = {
  OPEN: "quickadd.opened",
  DETECTED: "quickadd.detected",
  COMMITTED: "quickadd.committed",
};

export const QUICKADD_DOMAINS = /** @type {const} */ ([
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "inventory",
  "nutrition",
  "unknown",
]);

export function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function genId(prefix = "qa") {
  return `${prefix}_${Math.random()
    .toString(36)
    .slice(2)}_${Date.now().toString(36)}`;
}

export function nowIso() {
  return new Date().toISOString();
}
