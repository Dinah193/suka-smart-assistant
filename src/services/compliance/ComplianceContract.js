// src/services/compliance/ComplianceContract.js
//
// ComplianceContract
// ------------------
// Standard metadata that *every* artifact gets after scanning:
//   - recipes
//   - cleaning routines
//   - garden/seed plans
//   - animal/butchery protocols
//   - preservation workflows
//   - storehouse routines
//
// Pipeline role:
//   imports → intelligence (scan+normalize) → compliance meta → StepGraph → automation → (optional) Hub export
//
// This file does **not** persist anything by itself. It just:
//   - Normalizes compliance scan results into a standard shape.
//   - Emits a compliance.meta.built event for analytics/automation.
//   - Exposes helpers so any domain can quickly check compliant/blocked status.
//
// Downstream, domain save/SessionEngine code can attach this to artifacts as:
//
//   sessionMeta: {
//     stepGraphReady: true,
//     compliance: buildComplianceMeta({ ...scanResult })
//   }
//
// `compliance` shape:
//
//   {
//     status: "compliant" | "needsReview" | "blocked",
//     hardViolations: [ ... ],
//     softConflicts: [ ... ],
//     allergenRisks: [ ... ],
//     scannedAt: "ISO timestamp"
//   }
//
// NOTE: This module does *not* change inventory/storehouse/sessions directly,
// so it does not export to the Hub. The code that persists artifacts should
// decide when to call its own exportToHubIfEnabled helper.

/* ---------------------------------- Imports ---------------------------------- */

import { emitEvent } from "../eventBus";

/* --------------------------------- Constants --------------------------------- */

export const COMPLIANCE_STATUS = Object.freeze({
  COMPLIANT: "compliant",
  NEEDS_REVIEW: "needsReview",
  BLOCKED: "blocked",
});

/** Internal module source identifier for events. */
const MODULE_SOURCE = "services.compliance.ComplianceContract";

/* --------------------------------- Typedefs --------------------------------- */
/**
 * @typedef {Object} ComplianceIssue
 * @property {string} code        - Short machine-friendly code (e.g. "PORK", "BLEACH").
 * @property {string} [severity]  - Optional severity hint ("hard", "soft", "allergen", "info").
 * @property {string} message     - Human-readable description of the issue.
 * @property {Object} [meta]      - Optional domain-specific metadata (stepId, ingredientId, etc.).
 */

/**
 * @typedef {Object} ComplianceMeta
 * @property {"compliant"|"needsReview"|"blocked"} status
 * @property {ComplianceIssue[]} hardViolations
 * @property {ComplianceIssue[]} softConflicts
 * @property {ComplianceIssue[]} allergenRisks
 * @property {string} scannedAt  - ISO timestamp when this compliance snapshot was created.
 */

/* ------------------------------- Core Builder -------------------------------- */

/**
 * Build normalized compliance metadata from scan results.
 *
 * Usage:
 *   const compliance = buildComplianceMeta({
 *     status,
 *     hardViolations,
 *     softConflicts,
 *     allergenRisks
 *   });
 *
 * @param {Object} input
 * @param {"compliant"|"needsReview"|"blocked"|string} [input.status]
 * @param {Array<string|ComplianceIssue>} [input.hardViolations]
 * @param {Array<string|ComplianceIssue>} [input.softConflicts]
 * @param {Array<string|ComplianceIssue>} [input.allergenRisks]
 * @returns {ComplianceMeta}
 */
export function buildComplianceMeta({
  status,
  hardViolations,
  softConflicts,
  allergenRisks,
} = {}) {
  const ts = new Date().toISOString();

  const normalizedStatus = normalizeStatus(status);
  const normalizedHard = normalizeIssueList(hardViolations, "hard");
  const normalizedSoft = normalizeIssueList(softConflicts, "soft");
  const normalizedAllergen = normalizeIssueList(allergenRisks, "allergen");

  /** @type {ComplianceMeta} */
  const meta = {
    status: normalizedStatus,
    hardViolations: normalizedHard,
    softConflicts: normalizedSoft,
    allergenRisks: normalizedAllergen,
    scannedAt: ts,
  };

  emitSafe({
    type: "compliance.meta.built",
    ts,
    source: `${MODULE_SOURCE}.buildComplianceMeta`,
    data: {
      status: meta.status,
      hardViolationCount: meta.hardViolations.length,
      softConflictCount: meta.softConflicts.length,
      allergenRiskCount: meta.allergenRisks.length,
    },
  });

  return meta;
}

/* -------------------------- Convenience: Status Checks ----------------------- */

/**
 * Return true if the compliance meta is fully compliant.
 * @param {ComplianceMeta|null|undefined} meta
 */
export function isCompliant(meta) {
  return !!meta && meta.status === COMPLIANCE_STATUS.COMPLIANT;
}

/**
 * Return true if the compliance meta is blocked.
 * Blocked artifacts should *not* be auto-scheduled without user override.
 *
 * @param {ComplianceMeta|null|undefined} meta
 */
export function isBlocked(meta) {
  return !!meta && meta.status === COMPLIANCE_STATUS.BLOCKED;
}

/**
 * Return true if the artifact should be flagged for human review.
 *
 * @param {ComplianceMeta|null|undefined} meta
 */
export function needsReview(meta) {
  return !!meta && meta.status === COMPLIANCE_STATUS.NEEDS_REVIEW;
}

/**
 * Create a fully compliant, empty compliance meta object.
 * Helpful when a scan found no issues but you still want a standard shape.
 *
 * @returns {ComplianceMeta}
 */
export function createCompliantMeta() {
  return buildComplianceMeta({
    status: COMPLIANCE_STATUS.COMPLIANT,
    hardViolations: [],
    softConflicts: [],
    allergenRisks: [],
  });
}

/* ----------------------------- Normalization Helpers ------------------------ */

/**
 * Normalize status into one of the allowed values.
 *
 * @param {"compliant"|"needsReview"|"blocked"|string} status
 * @returns {"compliant"|"needsReview"|"blocked"}
 */
function normalizeStatus(status) {
  const lower = typeof status === "string" ? status.toLowerCase() : "";

  if (lower === COMPLIANCE_STATUS.COMPLIANT) return COMPLIANCE_STATUS.COMPLIANT;
  if (
    lower === "needsreview" ||
    lower === "needs_review" ||
    lower === "needs-review"
  ) {
    return COMPLIANCE_STATUS.NEEDS_REVIEW;
  }
  if (lower === COMPLIANCE_STATUS.BLOCKED) return COMPLIANCE_STATUS.BLOCKED;

  // Conservative default: require human review when status is unclear.
  return COMPLIANCE_STATUS.NEEDS_REVIEW;
}

/**
 * Normalize a list of issues (strings or objects) into ComplianceIssue objects.
 *
 * Accepts items like:
 *   "pork"
 *   { code: "PORK", message: "Contains pork shoulder", meta: { ingredientId: "123" } }
 *
 * @param {Array<string|ComplianceIssue>|undefined|null} list
 * @param {"hard"|"soft"|"allergen"} defaultSeverity
 * @returns {ComplianceIssue[]}
 */
function normalizeIssueList(list, defaultSeverity) {
  if (!Array.isArray(list) || list.length === 0) return [];

  const result = [];

  for (const item of list) {
    if (!item) continue;

    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) continue;

      result.push({
        code: toCodeFromString(trimmed),
        severity: defaultSeverity,
        message: trimmed,
        meta: {},
      });
      continue;
    }

    if (typeof item === "object") {
      const message =
        typeof item.message === "string" ? item.message.trim() : "";
      if (!message) continue;

      const code =
        typeof item.code === "string" && item.code.trim()
          ? item.code.trim()
          : toCodeFromString(message);

      result.push({
        code,
        severity:
          typeof item.severity === "string" && item.severity.trim()
            ? item.severity.trim()
            : defaultSeverity,
        message,
        meta:
          typeof item.meta === "object" && item.meta !== null ? item.meta : {},
      });
    }
  }

  return result;
}

/**
 * Turn a human-readable string into a CODE_LIKE identifier.
 *
 * @param {string} str
 * @returns {string}
 */
function toCodeFromString(str) {
  return (
    str
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "UNKNOWN"
  );
}

/* --------------------------------- Events ----------------------------------- */

/**
 * Safe wrapper around eventBus emit.
 *
 * @param {{ type: string, ts: string, source: string, data: any }} payload
 */
function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;

  try {
    emitEvent(payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[ComplianceContract] Failed to emit event", err);
    }
  }
}
