/* eslint-disable no-console */

// src/services/imports/importEvents.js
// Centralized event emit helpers for the Import Pipeline across ALL domains.

function nowIso() {
  return new Date().toISOString();
}

let eventBus = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb?.default || eb?.eventBus || eb;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("../events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2;
  } catch {
    eventBus = null;
  }
}

export const IMPORT_EVENTS = Object.freeze({
  PAGE_OPENED: "import.page.opened",
  RECEIVED: "import.received",
  PARSED: "import.parsed",
  NORMALIZED: "import.normalized",
  LINKED: "import.linked",
  INVENTORY_SHORTAGE: "inventory.shortage.detected",
  SESSION_DRAFT_CREATED: "session.draft.created",
});

export function emitImportEvent(type, payload) {
  const safePayload = {
    ...payload,
    ts: payload?.ts || nowIso(),
  };

  if (!eventBus || typeof eventBus.emit !== "function") {
    if (import.meta?.env?.DEV) {
      console.warn(
        "[importEvents] eventBus.emit unavailable:",
        type,
        safePayload
      );
    }
    return;
  }

  try {
    // SSA pattern: either eventBus.emit({type, ...}) OR eventBus.emit(type,payload)
    // Your repo has used the object-shape pattern in db.js hooks.
    eventBus.emit({
      type,
      ts: safePayload.ts,
      source: "import.pipeline",
      data: safePayload,
    });
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn("[importEvents] emit failed:", type, err);
    }
  }
}
