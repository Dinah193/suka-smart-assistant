// src/agents/shims/HouseholdReasoner.js
//
// HouseholdReasoner shim
// ----------------------
// This file is the “brain stem” for Suka Smart Assistant (SSA).
// It takes normalized inputs (imports, sessions, events) and routes them to
// domain shims (meals, cleaning, garden, animals, preservation, storehouse),
// then:
//
//   imports → intelligence → automation → (optional) Hub export
//
// - imports:   recipe/cleaning/garden/animal/storehouse/video data already
//              normalized by ImportRouter / ScraperEngine.
// - intelligence: domain shims turn inputs into plans, sessions, or insights.
// - automation:  automation runtime can schedule or propose sessions based
//                on the structured outputs from this reasoner.
// - Hub export:  when familyFundMode=true, data is formatted and exported to
//                the Suka Village Family Fund Hub, but SSA remains the source
//                of truth for household data.
//

/* ---------------------------------- Imports ---------------------------------- */

import * as eventBus from "@/services/events/eventBus";
import * as featureFlags from "@/config/featureFlags";
import * as HubPacketFormatterModule from "@/services/hub/HubPacketFormatter";
import * as FamilyFundConnectorModule from "@/services/hub/FamilyFundConnector";
import * as automationRuntimeModule from "@/services/automation/runtime";

// NEW: hook into HouseholdOrchestrator shim dispatcher
import {
  canHandleShim,
  dispatchShim,
} from "@/agents/shims/HouseholdOrchestrator";

/* --------------------------------- Constants --------------------------------- */

const SOURCE_ID = "agents/shims/HouseholdReasoner";

/**
 * The Reasoner contract:
 * - domain: one of "meals", "cleaning", "garden", "animals", "preservation", "storehouse"
 * - intent: what you want (e.g. "plan", "forecast", "suggestSessions", "scoreOptions", "explain")
 * - input:  domain-specific data (imports, current state, preferences)
 * - context: cross-domain context (inventory, storehouse, calendar, household profile, etc.)
 *
 * Example:
 *   reason({
 *     domain: "meals",
 *     intent: "plan",
 *     input: { windowDays: 14, people: 4 },
 *     context: { inventorySnapshot, storehouseProfile, calendarWindow }
 *   })
 */

/* ---------------------- EventBus + Automation helpers ------------------------ */

const rawEmit = eventBus.emit || eventBus.default?.emit || (() => {});

function emitEvent({ type, data }) {
  const envelope = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE_ID,
    data: data || {},
  };

  // Prefer single-arg envelope emit; fall back to (type, payload)
  try {
    rawEmit(envelope);
  } catch {
    try {
      rawEmit(envelope.type, envelope);
    } catch {
      // swallow — UI should not explode because of eventBus wiring
    }
  }

  // Also notify automation runtime if present
  try {
    const automation =
      automationRuntimeModule.automation ||
      automationRuntimeModule.default ||
      automationRuntimeModule;
    automation?.emit?.("event", envelope);
  } catch {
    // non-blocking
  }

  return envelope;
}

/* ----------------------------- Hub export helper ----------------------------- */

const HubPacketFormatter =
  HubPacketFormatterModule.default || HubPacketFormatterModule;
const FamilyFundConnector =
  FamilyFundConnectorModule.default || FamilyFundConnectorModule;

function familyFundEnabled() {
  // Be defensive about how featureFlags is shaped
  if (featureFlags.familyFundMode === true) return true;
  if (typeof featureFlags.isFamilyFundMode === "function") {
    try {
      return !!featureFlags.isFamilyFundMode();
    } catch {
      return false;
    }
  }
  if (featureFlags.default?.familyFundMode === true) return true;
  return false;
}

/**
 * exportToHubIfEnabled
 * --------------------
 * Called when a reasoning run leads to concrete changes:
 * - inventory updates
 * - storehouse allocations
 * - generated or updated sessions
 *
 * payload is a HIGH-LEVEL description of what changed, not a full DB diff.
 */
async function exportToHubIfEnabled(payload) {
  if (!familyFundEnabled()) return;

  try {
    const packet = HubPacketFormatter?.format
      ? HubPacketFormatter.format("household.reasoner.result", payload)
      : {
          type: "household.reasoner.result",
          ts: new Date().toISOString(),
          data: payload,
        };

    if (FamilyFundConnector?.send) {
      await FamilyFundConnector.send(packet);
    } else if (FamilyFundConnector?.publish) {
      await FamilyFundConnector.publish(packet);
    }
    // Ignore the return; Hub is downstream/optional
  } catch {
    // Hub issues must never break SSA; fail silently
  }
}

/* ------------------------------ Domain loading ------------------------------- */

/**
 * Lazy-loadable domain shims. Each loader returns a module whose default export
 * (or top-level object) is expected to implement at least one of:
 * - reason(request)
 * - handle(request)
 * - handleCommand(intent, payload)
 *
 * IMPORTANT (your request):
 * - Remove ALL references to Agent files.
 * - Only load the appropriate Shims.
 */
const DOMAIN_SHIM_LOADERS = {
  meals: async () =>
    (await import("@/agents/shims/mealPlanningShim")).default ??
    (await import("@/agents/shims/mealPlanningShim")),

  cleaning: async () =>
    (await import("@/agents/shims/cleaningShim")).default ??
    (await import("@/agents/shims/cleaningShim")),

  garden: async () =>
    (await import("@/agents/shims/gardenPlanShim")).default ??
    (await import("@/agents/shims/gardenPlanShim")),

  animals: async () =>
    (await import("@/agents/shims/animalShim")).default ??
    (await import("@/agents/shims/animalShim")),

  preservation: async () =>
    (await import("@/agents/shims/preservationShim")).default ??
    (await import("@/agents/shims/preservationShim")),

  storehouse: async () =>
    (await import("@/agents/shims/storehouseShim")).default ??
    (await import("@/agents/shims/storehouseShim")),
};

// cache to avoid re-importing on every reasoning call
const domainShimCache = new Map();

/**
 * getDomainShim(domain)
 * ---------------------
 * Load and cache a domain shim. This is the extension point for new domains:
 * just add entries to DOMAIN_SHIM_LOADERS and they become available immediately.
 */
async function getDomainShim(domain) {
  if (domainShimCache.has(domain)) return domainShimCache.get(domain);
  const loader = DOMAIN_SHIM_LOADERS[domain];
  if (!loader) return null;

  try {
    const shim = await loader();
    domainShimCache.set(domain, shim);
    return shim;
  } catch (err) {
    console.error(
      `[HouseholdReasoner] Failed to load shim for domain "${domain}"`,
      err
    );
    return null;
  }
}

/* ------------------------------ Core reasoning ------------------------------- */

/**
 * Normalize a raw result from a domain shim into a common envelope.
 */
function normalizeResult({ domain, intent, raw }) {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      domain,
      intent,
      error: "EMPTY_RESULT",
      result: null,
      meta: { normalized: true },
    };
  }

  // If the domain shim already returns { ok, result } we respect that.
  const ok = typeof raw.ok === "boolean" ? raw.ok : true;

  const result = raw.result ?? raw;

  const meta = {
    normalized: true,
    ...(raw.meta || {}),
  };

  return {
    ok,
    domain,
    intent,
    result,
    meta,
  };
}

/**
 * detectDataChanges
 * -----------------
 * Look inside a normalized reasoning envelope to see if it implies any
 * household data changes (inventory, storehouse, sessions).
 */
function detectDataChanges(envelope) {
  const { result } = envelope || {};
  if (!result || typeof result !== "object") {
    return {
      hasInventoryChanges: false,
      hasStorehouseChanges: false,
      hasSessions: false,
      summary: null,
    };
  }

  const hasSessions =
    Array.isArray(result.sessions) ||
    Array.isArray(result.suggestedSessions) ||
    Array.isArray(result.generatedSessions);

  const hasInventoryChanges =
    Array.isArray(result.inventoryUpdates) ||
    Array.isArray(result.inventoryDeltas) ||
    !!result.inventoryPlan;

  const hasStorehouseChanges =
    Array.isArray(result.storehouseAllocations) || !!result.storehousePlan;

  const summary = {
    sessionCount:
      result.sessions?.length ||
      result.suggestedSessions?.length ||
      result.generatedSessions?.length ||
      0,
    inventoryUpdatesCount: result.inventoryUpdates?.length || 0,
    storehouseAllocationsCount: result.storehouseAllocations?.length || 0,
  };

  return {
    hasInventoryChanges,
    hasStorehouseChanges,
    hasSessions,
    summary,
  };
}

/**
 * routeToDomainShim
 * -----------------
 * Actually calls a domain shim in a defensive way:
 * - tries reason(request)
 * - then handle(request)
 * - then handleCommand(intent, payload)
 */
async function routeToDomainShim(shim, { domain, intent, input, context }) {
  if (!shim || typeof shim !== "object") {
    throw new Error(`No shim loaded for domain "${domain}"`);
  }

  // Try reason(request)
  if (typeof shim.reason === "function") {
    return await shim.reason({ domain, intent, input, context });
  }
  // Try handle(request)
  if (typeof shim.handle === "function") {
    return await shim.handle({ domain, intent, input, context });
  }
  // Try handleCommand(intent, payload)
  if (typeof shim.handleCommand === "function") {
    return await shim.handleCommand(intent, { input, context, domain });
  }

  throw new Error(
    `Domain shim for "${domain}" does not implement a known interface.`
  );
}

/* ----------------------------------- API ------------------------------------- */

/**
 * reason(request)
 * ---------------
 * Main entry point for other SSA modules (ImportRouter, SessionEngines, UI pages).
 * This is what you call when you want cross-domain intelligent behavior.
 */
export async function reason(request) {
  const tsStart = Date.now();
  const safeReq = request && typeof request === "object" ? request : {};
  const domain = String(safeReq.domain || "")
    .toLowerCase()
    .trim();
  const intent = String(safeReq.intent || "").trim();
  const input = safeReq.input ?? null;
  const context = safeReq.context ?? {};
  const shimType = safeReq.shimType || intent; // allows intent to be a shim key

  if (!domain) {
    const envelope = emitEvent({
      type: "reasoner.error",
      data: {
        reason: "MISSING_DOMAIN",
        request: safeReq,
      },
    });
    return {
      ok: false,
      domain: null,
      intent,
      error: "MISSING_DOMAIN",
      result: null,
      meta: { event: envelope },
    };
  }

  if (!intent) {
    const envelope = emitEvent({
      type: "reasoner.error",
      data: {
        reason: "MISSING_INTENT",
        domain,
        request: safeReq,
      },
    });
    return {
      ok: false,
      domain,
      intent: null,
      error: "MISSING_INTENT",
      result: null,
      meta: { event: envelope },
    };
  }

  const invocationEvent = emitEvent({
    type: "reasoner.invoked",
    data: {
      domain,
      intent,
      hasInput: !!input,
      contextShape: Object.keys(context || {}),
      shimType: shimType !== intent ? shimType : undefined,
    },
  });

  try {
    /* ---------------------------------------------------------------------- */
    /* 1) Shim-aware short-circuit (HouseholdOrchestrator)                    */
    /* ---------------------------------------------------------------------- */
    if (canHandleShim(shimType)) {
      const shimRes = await dispatchShim({
        type: shimType,
        domain,
        payload: {
          input,
          context,
          originalIntent: intent,
          from: "HouseholdReasoner",
        },
      });

      const dtMs = Date.now() - tsStart;

      const normalized = {
        ok: !!shimRes?.ok,
        domain: shimRes?.domain || domain,
        intent: shimType,
        result: {
          session: shimRes?.session || null,
          sessionId: shimRes?.sessionId || null,
          generatedSessions: shimRes?.session ? [shimRes.session] : [],
          reason: shimRes?.reason,
          warnings: shimRes?.warnings || [],
          meta: shimRes?.meta || {},
        },
        meta: {
          normalized: true,
          viaShim: true,
          shimType,
        },
      };

      const changes = detectDataChanges(normalized);

      const resultEnvelope = emitEvent({
        type: "reasoner.completed",
        data: {
          domain: normalized.domain,
          intent: normalized.intent,
          ok: normalized.ok,
          durationMs: dtMs,
          dataChanges: changes.summary,
          viaShim: true,
        },
      });

      if (
        normalized.ok &&
        (changes.hasInventoryChanges ||
          changes.hasStorehouseChanges ||
          changes.hasSessions)
      ) {
        exportToHubIfEnabled({
          domain: normalized.domain,
          intent: normalized.intent,
          durationMs: dtMs,
          invocationEvent,
          resultEvent: resultEnvelope,
          changes: changes.summary,
          viaShim: true,
        });
      }

      // Hand result to automation runtime for follow-up scheduling
      try {
        const automation =
          automationRuntimeModule.automation ||
          automationRuntimeModule.default ||
          automationRuntimeModule;
        automation?.handleReasonerResult?.({
          domain: normalized.domain,
          intent: normalized.intent,
          normalized,
          changes,
          invocationEvent,
          resultEvent: resultEnvelope,
        });
      } catch {
        // non-blocking
      }

      return normalized;
    }

    /* ---------------------------------------------------------------------- */
    /* 2) Normal domain-shim routing (meals, cleaning, etc.)                  */
    /* ---------------------------------------------------------------------- */

    const shim = await getDomainShim(domain);
    if (!shim) {
      throw new Error(`Unknown or unavailable domain "${domain}"`);
    }

    const raw = await routeToDomainShim(shim, {
      domain,
      intent,
      input,
      context,
    });

    const normalized = normalizeResult({ domain, intent, raw });
    const dtMs = Date.now() - tsStart;

    const changes = detectDataChanges(normalized);

    const resultEnvelope = emitEvent({
      type: "reasoner.completed",
      data: {
        domain,
        intent,
        ok: normalized.ok,
        durationMs: dtMs,
        dataChanges: changes.summary,
      },
    });

    // If these results imply concrete household changes, export to Hub
    if (
      normalized.ok &&
      (changes.hasInventoryChanges ||
        changes.hasStorehouseChanges ||
        changes.hasSessions)
    ) {
      exportToHubIfEnabled({
        domain,
        intent,
        durationMs: dtMs,
        invocationEvent,
        resultEvent: resultEnvelope,
        changes: changes.summary,
        // High-level payload only — NOT full DB content
      });
    }

    // Hand result to automation runtime for follow-up scheduling
    try {
      const automation =
        automationRuntimeModule.automation ||
        automationRuntimeModule.default ||
        automationRuntimeModule;
      automation?.handleReasonerResult?.({
        domain,
        intent,
        normalized,
        changes,
        invocationEvent,
        resultEvent: resultEnvelope,
      });
    } catch {
      // non-blocking
    }

    return normalized;
  } catch (err) {
    const dtMs = Date.now() - tsStart;
    console.error(
      `[HouseholdReasoner] Error in reason() for domain=${domain}, intent=${intent}`,
      err
    );

    const errorEvent = emitEvent({
      type: "reasoner.failed",
      data: {
        domain,
        intent,
        durationMs: dtMs,
        message: err?.message || "Unknown error",
      },
    });

    return {
      ok: false,
      domain,
      intent,
      error: err?.message || "UNKNOWN_ERROR",
      result: null,
      meta: { event: errorEvent },
    };
  }
}

/**
 * handleEvent
 * -----------
 * Optional convenience hook if you want to pump eventBus events directly into
 * this reasoner (e.g. inventory.updated → evaluate meal sessions).
 * You can wire this in src/services/eventBus if desired.
 */
export async function handleEvent(event) {
  const safe = event && typeof event === "object" ? event : {};
  const type = safe.type || "";

  // Example: you can extend this mapping as you add richer automation.
  if (type === "inventory.updated") {
    // ask the meals + storehouse domains if any sessions or stock plans
    // should be adapted; we don’t await them in parallel here because this
    // is just a convenience — callers can still orchestrate manually.
    await reason({
      domain: "meals",
      intent: "refreshPlanFromInventory",
      input: { event: safe },
      context: {},
    });
    await reason({
      domain: "storehouse",
      intent: "refreshStockPlanFromInventory",
      input: { event: safe },
      context: {},
    });
  }

  if (type === "garden.harvest.logged") {
    await reason({
      domain: "meals",
      intent: "suggestSessionsFromHarvest",
      input: { event: safe },
      context: {},
    });
    await reason({
      domain: "preservation",
      intent: "suggestJobsFromHarvest",
      input: { event: safe },
      context: {},
    });
  }

  // extend with more event→intent mappings as the system grows
}

/**
 * getCapabilities
 * ---------------
 * Tiny helper for UI / debugging to ask what this reasoner *claims* it can do.
 * The actual implementation lives in domain shims; this is just a registry view.
 */
export function getCapabilities() {
  return {
    source: SOURCE_ID,
    domains: Object.keys(DOMAIN_SHIM_LOADERS),
    shimAware: true,
    // You can extend this with a per-domain introspection later
    // by adding a getCapabilities() method to each domain shim and
    // having HouseholdReasoner aggregate the results.
  };
}

const HouseholdReasoner = {
  reason,
  handleEvent,
  getCapabilities,
};

export default HouseholdReasoner;
