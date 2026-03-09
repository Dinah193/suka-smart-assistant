// C:\Users\larho\suka-smart-assistant\src\import\ImportService.js
// Main orchestrator for ALL import flows
// -----------------------------------------------------------------------------
// PIPELINE OVERVIEW
// UI (ImportLanding.jsx / bookmarklet / mobile share) →
//   ImportService.importPayload({ domain?, raw, meta? })
//     → ImportRouter.routeImport(...)        (which parser?)
//     → parser.parse(raw, meta)              (domain-specific shape)
//     → ImportNormalizer.normalizeImport(...) (SSA internal schema + context)
//     → emit events for automation runtime
//     → (optional) auto-check inventory / auto-schedule / show preview
//     → (optional) export to Hub when familyFundMode=true
//
// GOALS
// - Accept multiple domains: recipe, cleaning, garden/seed, animal/butchery,
//   storehouse, video/how-to, preservation (future-ready).
// - Every import becomes context intelligence for future automations.
// - Emit a consistent event payload: { type, ts, source, data }.
// - Respect user import settings (auto-check inventory, auto-schedule, preview).
// - Be defensive: bad imports don’t break the whole runtime.
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists
// - src/import/ImportRouter.js exists
// - src/import/ImportNormalizer.js exists
// - src/config/index.js (or ../config) exposes featureFlags + env
// - HubPacketFormatter and FamilyFundConnector exist (for Hub export)
//
// IMPORTANT
// - THIS FILE DOES NOT render UI — it just orchestrates the whole import story.
// - UI can listen to: "ui.import.preview.show" to pop the ImportPreviewModal.
// -----------------------------------------------------------------------------

import eventBus from "../services/events/eventBus";
import ImportRouter from "./ImportRouter";
import ImportNormalizer from "./ImportNormalizer";
import config from "../config";

// localStorage key must match ImportSettings.jsx
const SETTINGS_KEY = "ssa.import.settings";

// -----------------------------------------------------------------------------
// Default settings (mirrors ImportSettings.jsx)
// -----------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  autoCheckInventory: true,
  autoScheduleSessions: false,
  showPreviewModal: true,
  trustSiteAllowList: true,
  autoExportToHub: false,
};

// -----------------------------------------------------------------------------
// SETTINGS UTILITIES
// -----------------------------------------------------------------------------
function loadImportSettings() {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    console.warn(
      "[ImportService] failed to load settings; using defaults:",
      err
    );
    return { ...DEFAULT_SETTINGS };
  }
}

// -----------------------------------------------------------------------------
// Event helper
// -----------------------------------------------------------------------------
function emitImportEvent(type, data = {}) {
  eventBus.emit(type, {
    type,
    ts: new Date().toISOString(),
    source: "import.service",
    data,
  });
}

// -----------------------------------------------------------------------------
// Hub export helper
// -----------------------------------------------------------------------------
async function exportToHubIfEnabled(payload, force = false) {
  try {
    const flags =
      (config &&
        (config.featureFlags ||
          (typeof config === "function" ? config().featureFlags : {}))) ||
      config.featureFlags ||
      {};
    const familyFundMode =
      flags.familyFundMode === true || flags.familyFundMode === "true";

    if (!familyFundMode && !force) return;

    const { default: HubPacketFormatter } = await import(
      "@/services/hub/HubPacketFormatter.js"
    );
    const { default: FamilyFundConnector } = await import(
      "@/services/hub/FamilyFundConnector.js"
    );

    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // keep silent — SSA owns data
    console.warn(
      "[ImportService] Hub export failed (silent):",
      err?.message || err
    );
  }
}

// -----------------------------------------------------------------------------
// MAIN: importPayload
// - input: { domain?, raw, meta? }
// - output: { ok, domain, parsed, normalized, settings, warnings?, ... }
// -----------------------------------------------------------------------------
async function importPayload({ domain, raw, meta = {} } = {}) {
  const ts = new Date().toISOString();
  const settings = loadImportSettings();

  if (!raw) {
    const out = {
      ok: false,
      error: "No raw data provided to import.",
      settings,
    };
    emitImportEvent("import.failed", out);
    return out;
  }

  // step 1: acknowledge receipt
  emitImportEvent("import.received", {
    domain: domain || "auto",
    preview: typeof raw === "string" ? raw.slice(0, 140) : "[non-string]",
    meta,
    settings,
  });

  // step 2: route → get parser
  const routeResult = await ImportRouter.routeImport({ domain, raw, meta });
  if (!routeResult?.ok) {
    const out = {
      ok: false,
      error: routeResult?.error || "Router could not find a parser.",
      reason: routeResult?.reason || "router-failed",
      settings,
    };
    emitImportEvent("import.failed", out);
    return out;
  }

  const resolvedDomain = routeResult.domain;
  const parser = routeResult.parser;
  if (!parser || typeof parser.parse !== "function") {
    const out = {
      ok: false,
      error: "Parser is missing or does not expose .parse(...).",
      domain: resolvedDomain,
      settings,
    };
    emitImportEvent("import.failed", out);
    return out;
  }

  // step 3: parse
  let parsed;
  try {
    parsed = await parser.parse(raw, meta);
  } catch (err) {
    const out = {
      ok: false,
      error: "Parser threw an error: " + (err?.message || err),
      domain: resolvedDomain,
      settings,
    };
    console.error("[ImportService] parser error:", err);
    emitImportEvent("import.failed", out);
    return out;
  }

  emitImportEvent("import.parsed", {
    domain: resolvedDomain,
    parsedPreview:
      typeof parsed === "object"
        ? Object.keys(parsed).slice(0, 12)
        : "[non-object]",
    meta,
  });

  // step 4: normalize
  const normalizedResult = await ImportNormalizer.normalizeImport({
    domain: resolvedDomain,
    parsed,
    raw,
    meta,
  });

  if (!normalizedResult?.ok) {
    const out = {
      ok: false,
      error: normalizedResult?.error || "Normalization failed.",
      domain: resolvedDomain,
      parsed,
      settings,
    };
    emitImportEvent("import.failed", out);
    return out;
  }

  const {
    normalized,
    context,
    sessions = [],
    inventoryChanges = [],
    storehouseChanges = [],
    warnings = [],
  } = normalizedResult;

  // step 5: AUTO-ACTIONS based on settings
  // --------------------------------------
  // 5a. auto-check inventory
  if (settings.autoCheckInventory) {
    emitImportEvent("inventory.check.request", {
      domain: resolvedDomain,
      context,
      normalized,
      // let inventory engine decide how to check (ingredients, storehouse, garden)
    });
    eventBus.emit("inventory.check.request", {
      type: "inventory.check.request",
      ts: new Date().toISOString(),
      source: "import.service",
      data: {
        domain: resolvedDomain,
        context,
        normalized,
      },
    });
  }

  // 5b. auto-schedule sessions
  if (
    settings.autoScheduleSessions &&
    Array.isArray(sessions) &&
    sessions.length > 0
  ) {
    emitImportEvent("automation.schedule.request", {
      domain: resolvedDomain,
      sessions,
      normalized,
    });
    eventBus.emit("automation.schedule.request", {
      type: "automation.schedule.request",
      ts: new Date().toISOString(),
      source: "import.service",
      data: {
        domain: resolvedDomain,
        sessions,
        normalized,
      },
    });
  }

  // 5c. show preview modal
  if (settings.showPreviewModal) {
    // UI layer should listen to this and open ImportPreviewModal
    eventBus.emit("ui.import.preview.show", {
      type: "ui.import.preview.show",
      ts: new Date().toISOString(),
      source: "import.service",
      data: {
        domain: resolvedDomain,
        parsed,
        normalizedResult,
        settings,
      },
    });
  }

  // 5d. if the import ITSELF carries data changes → emit the change events
  const hasInventoryChanges =
    Array.isArray(inventoryChanges) && inventoryChanges.length > 0;
  const hasStorehouseChanges =
    Array.isArray(storehouseChanges) && storehouseChanges.length > 0;
  const hasSessions = Array.isArray(sessions) && sessions.length > 0;

  if (hasInventoryChanges) {
    eventBus.emit("inventory.updated", {
      type: "inventory.updated",
      ts: new Date().toISOString(),
      source: "import.service",
      data: {
        domain: resolvedDomain,
        changes: inventoryChanges,
      },
    });
  }

  if (hasStorehouseChanges) {
    eventBus.emit("storehouse.updated", {
      type: "storehouse.updated",
      ts: new Date().toISOString(),
      source: "import.service",
      data: {
        domain: resolvedDomain,
        changes: storehouseChanges,
      },
    });
  }

  // (meals, cleaning, garden, animal, preservation) → sessions
  if (hasSessions) {
    eventBus.emit("session.generated", {
      type: "session.generated",
      ts: new Date().toISOString(),
      source: "import.service",
      data: {
        domain: resolvedDomain,
        sessions,
      },
    });
  }

  // step 6: (optional) HUB EXPORT
  const needsHubExport =
    settings.autoExportToHub &&
    (hasInventoryChanges || hasStorehouseChanges || hasSessions);
  if (needsHubExport) {
    await exportToHubIfEnabled(
      {
        kind: "import",
        domain: resolvedDomain,
        data: {
          normalized,
          context,
          sessions,
          inventoryChanges,
          storehouseChanges,
          warnings,
          meta,
        },
        ts,
      },
      // force: false (respect familyFundMode)
      false
    );
  }

  // step 7: final success event
  emitImportEvent("import.completed", {
    domain: resolvedDomain,
    sessions: sessions.length,
    inventoryChanges: inventoryChanges.length,
    storehouseChanges: storehouseChanges.length,
    warnings,
    settings,
  });

  return {
    ok: true,
    domain: resolvedDomain,
    parsed,
    normalized,
    context,
    sessions,
    inventoryChanges,
    storehouseChanges,
    warnings,
    settings,
  };
}

// -----------------------------------------------------------------------------
// EXTRA: quick helper for raw URL imports (can be used by bookmarklet/mobile)
// -----------------------------------------------------------------------------
async function importUrl(url, meta = {}) {
  return importPayload({
    raw: url,
    meta: { ...meta, kind: "url" },
  });
}

// -----------------------------------------------------------------------------
// EXTRA: quick helper for raw text imports
// -----------------------------------------------------------------------------
async function importText(text, meta = {}) {
  return importPayload({
    raw: text,
    meta: { ...meta, kind: "text" },
  });
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
const ImportService = {
  importPayload,
  importUrl,
  importText,
  loadImportSettings,
  __exportToHubIfEnabled: exportToHubIfEnabled,
  __emitImportEvent: emitImportEvent,
};

export default ImportService;
