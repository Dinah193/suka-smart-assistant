// src/services/hub/exportToHubIfEnabled.js
// -----------------------------------------------------------------------------
// exportToHubIfEnabled
// -----------------------------------------------------------------------------
// How this fits in the SSA pipeline:
//
//   imports → intelligence → automation → (optional) hub export
//
// - SSA’s “intelligence” and “automation” layers (engines, shims, db hooks)
//   call this helper whenever household data changes or when a session
//   produces analytics that *might* be interesting to the Family Fund Hub.
// - This module is the **only place** that knows about featureFlags.familyFundMode
//   and how to actually talk to the Hub (via HubPacketFormatter +
//   FamilyFundConnector).
// - Callers stay simple:
//
//     import { exportToHubIfEnabled } from "@/services/hub/exportToHubIfEnabled";
//
//     await exportToHubIfEnabled({
//       domain: "cooking",
//       kind: "session.analytics",
//       payload: { /* … */ },
//     });
//
// - If familyFundMode is false, this is a no-op.
// - If the Hub is unreachable, this fails silently in production (logs in dev).
//
// This keeps SSA fully functional on its own, and treats Hub export
// as an optional side-channel.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import eventBus from "@/services/events/eventBus.js";
import HubPacketFormatter from "./HubPacketFormatter.js";
import FamilyFundConnector from "./FamilyFundConnector.js";
import featureFlags from "@/config/featureFlags.json";

const SOURCE = "HubExportHelper";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit a strongly-shaped SSA event on the shared eventBus.
 *
 * @param {string} type
 * @param {object} data
 */
function emitEvent(type, data) {
  if (!eventBus || typeof eventBus.emit !== "function") return;

  try {
    eventBus.emit({
      type,
      ts: nowIso(),
      source: SOURCE,
      data,
    });
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn(`[${SOURCE}] Failed to emit event ${type}`, err);
    }
  }
}

/**
 * Resolve whether Hub export is enabled from feature flags, with an optional
 * override from callers (for testing or per-call switches).
 *
 * @param {object} [overrideFlags]
 */
function isFamilyFundModeEnabled(overrideFlags) {
  const flags = overrideFlags || featureFlags || {};
  return Boolean(flags.familyFundMode);
}

/* -------------------------------------------------------------------------- */
/* Core helper                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Export household data to the Family Fund Hub *if* familyFundMode is enabled.
 *
 * @param {object} args
 * @param {string} args.domain   Logical domain ("inventory", "sessions", "cooking", etc.)
 * @param {string} [args.kind]   Optional sub-type ("session.analytics", "snapshot", etc.)
 * @param {object} [args.payload] Arbitrary structured payload to export.
 * @param {object} [args.featureFlagsOverride] Optional flags object to override
 *                                            global featureFlags (useful in tests).
 *
 * @returns {Promise<boolean>}   Resolves to true if an export was attempted,
 *                               false if skipped (e.g. familyFundMode=false or
 *                               invalid inputs).
 */
export async function exportToHubIfEnabled(args = {}) {
  const { domain, kind, payload, featureFlagsOverride } = args;

  // Basic input validation
  if (!domain || typeof domain !== "string") {
    if (import.meta?.env?.DEV) {
      console.warn(
        `[${SOURCE}] exportToHubIfEnabled called without a valid domain`,
        args
      );
    }
    return false;
  }

  // If there's literally nothing to send, bail early.
  if (!payload || typeof payload !== "object") {
    if (import.meta?.env?.DEV) {
      console.warn(
        `[${SOURCE}] exportToHubIfEnabled called without a payload object`,
        args
      );
    }
    return false;
  }

  // Respect featureFlags.familyFundMode
  if (!isFamilyFundModeEnabled(featureFlagsOverride)) {
    emitEvent("hub.export.skipped", {
      reason: "familyFundMode_disabled",
      domain,
      kind: kind || null,
    });
    return false;
  }

  // Ensure hub helpers exist
  const hasFormatter =
    HubPacketFormatter && typeof HubPacketFormatter.format === "function";
  const hasConnector =
    FamilyFundConnector && typeof FamilyFundConnector.send === "function";

  if (!hasFormatter || !hasConnector) {
    if (import.meta?.env?.DEV) {
      console.warn(`[${SOURCE}] Hub helpers unavailable; skipping export`, {
        hasFormatter,
        hasConnector,
      });
    }
    emitEvent("hub.export.skipped", {
      reason: "helpers_unavailable",
      domain,
      kind: kind || null,
    });
    return false;
  }

  // At this point we *intend* to export; from here on, never throw to callers.
  try {
    const ts = nowIso();

    const packet = HubPacketFormatter.format({
      domain,
      kind: kind || null,
      ts,
      payload,
    });

    await FamilyFundConnector.send(packet);

    emitEvent("hub.export.sent", {
      domain,
      kind: kind || null,
      ts,
    });

    return true;
  } catch (err) {
    // Fails silently in production; logs + event in dev.
    if (import.meta?.env?.DEV) {
      console.warn(`[${SOURCE}] Hub export failed`, err);
    }

    emitEvent("hub.export.failed", {
      domain,
      kind: kind || null,
      error: err?.message || String(err),
    });

    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Default export (for convenience)                                           */
/* -------------------------------------------------------------------------- */

export default exportToHubIfEnabled;
