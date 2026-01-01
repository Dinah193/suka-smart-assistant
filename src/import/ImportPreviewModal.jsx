// C:\Users\larho\suka-smart-assistant\src\import\ImportPreviewModal.jsx
// Shows parsed import and next-step options
// -----------------------------------------------------------------------------
// WHERE THIS LIVES IN THE PIPELINE
// ImportLanding.jsx (user dropped/pasted/uploaded) → ImportService.js
//   → ImportRouter.js → Parser → ImportNormalizer.js
//   → **ImportPreviewModal.jsx** (this file) → user chooses "what to do next"
//   → emits events to automation runtime / session engines
//   → (optional) export to Hub if familyFundMode=true
//
// PURPOSE
// - Give the user a quick look at what SSA understood from their import
// - Show domain, title, sessions it can create, inventory/storehouse changes,
//   and context intelligence (ingredients, methods, equipment, seasonality)
// - Offer NEXT-STEP buttons:
//    ✓ "Save as favorite session"
//    ✓ "Schedule it"
//    ✓ "Send to Inventory"
//    ✓ "Send to Garden Planner"
//    ✓ "Export to Hub" (if available)
// - Emit consistent event payloads to eventBus to keep the app event-driven
//
// IMPORTANT
// - This UI component itself does not *have* to change data, but it can REQUEST
//   actions from the automation runtime. Those actions will in turn emit the
//   data-changing events (inventory.updated, session.saved, etc.).
// - We still include exportToHubIfEnabled(...) for the explicit "Export to Hub"
//   button, because you asked that actions that can change household data also
//   offer Hub mirroring.
// -----------------------------------------------------------------------------

import React from "react";
import eventBus from "../services/eventBus";
import config from "../config";

// -----------------------------------------------------------------------------
// Optional Hub export helper
// -----------------------------------------------------------------------------
async function exportToHubIfEnabled(payload) {
  try {
    const flags =
      (config && (config.featureFlags || (typeof config === "function" ? config().featureFlags : {}))) ||
      config.featureFlags ||
      {};
    const familyFundMode = flags.familyFundMode === true || flags.familyFundMode === "true";
    if (!familyFundMode) return;

    const { default: HubPacketFormatter } = await import("../services/HubPacketFormatter.js");
    const { default: FamilyFundConnector } = await import("../services/FamilyFundConnector.js");

    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // SSA owns the data — Hub is best-effort
    console.warn("[ImportPreviewModal] Hub export failed (silent):", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// Event emitter for UI-level telemetry
// -----------------------------------------------------------------------------
function emitImportUiEvent(type, data = {}) {
  eventBus.emit(type, {
    type,
    ts: new Date().toISOString(),
    source: "import.preview.modal",
    data,
  });
}

// -----------------------------------------------------------------------------
// Helpers to make small badges
// -----------------------------------------------------------------------------
function Badge({ children }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-[2px] rounded-full bg-slate-100 text-slate-700 text-[10px] uppercase tracking-wide">
      {children}
    </span>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------
export default function ImportPreviewModal({
  open,
  onClose,
  parsedImport, // expected: result from ImportNormalizer.normalizeImport(...)
  onConfirmAction, // optional: parent can listen to chosen actions
}) {
  if (!open) return null;

  const domain = parsedImport?.domain || "unknown";
  const normalized = parsedImport?.normalized || {};
  const context = parsedImport?.context || {};
  const sessions = Array.isArray(parsedImport?.sessions) ? parsedImport.sessions : [];
  const inventoryChanges = Array.isArray(parsedImport?.inventoryChanges) ? parsedImport.inventoryChanges : [];
  const storehouseChanges = Array.isArray(parsedImport?.storehouseChanges) ? parsedImport.storehouseChanges : [];
  const warnings = Array.isArray(parsedImport?.warnings) ? parsedImport.warnings : [];

  const title =
    normalized?.title ||
    normalized?.name ||
    (parsedImport?.domain ? `Imported ${parsedImport.domain}` : "Imported item");

  // ---------------------------------------------------------------------------
  // ACTION HANDLERS
  // ---------------------------------------------------------------------------
  const handleSaveFavorite = () => {
    const payload = {
      action: "session.favorite.save",
      domain,
      sessions,
      source: "import.preview.modal",
      ts: new Date().toISOString(),
    };
    emitImportUiEvent("import.preview.favorite.requested", payload);
    eventBus.emit("session.favorite.request", {
      type: "session.favorite.request",
      ts: new Date().toISOString(),
      source: "import.preview.modal",
      data: payload,
    });
    if (typeof onConfirmAction === "function") onConfirmAction(payload);
  };

  const handleSchedule = () => {
    const payload = {
      action: "automation.schedule.request",
      domain,
      sessions,
      source: "import.preview.modal",
      ts: new Date().toISOString(),
    };
    emitImportUiEvent("import.preview.schedule.requested", payload);
    eventBus.emit("automation.schedule.request", {
      type: "automation.schedule.request",
      ts: new Date().toISOString(),
      source: "import.preview.modal",
      data: payload,
    });
    if (typeof onConfirmAction === "function") onConfirmAction(payload);
  };

  const handleSendToInventory = () => {
    const payload = {
      action: "inventory.update.request",
      domain,
      inventoryChanges,
      source: "import.preview.modal",
      ts: new Date().toISOString(),
    };
    emitImportUiEvent("import.preview.inventory.requested", payload);
    eventBus.emit("inventory.update.request", {
      type: "inventory.update.request",
      ts: new Date().toISOString(),
      source: "import.preview.modal",
      data: payload,
    });
    if (typeof onConfirmAction === "function") onConfirmAction(payload);
  };

  const handleSendToStorehouse = () => {
    const payload = {
      action: "storehouse.update.request",
      domain,
      storehouseChanges,
      source: "import.preview.modal",
      ts: new Date().toISOString(),
    };
    emitImportUiEvent("import.preview.storehouse.requested", payload);
    eventBus.emit("storehouse.update.request", {
      type: "storehouse.update.request",
      ts: new Date().toISOString(),
      source: "import.preview.modal",
      data: payload,
    });
    if (typeof onConfirmAction === "function") onConfirmAction(payload);
  };

  const handleExportToHub = async () => {
    const payload = {
      kind: "import.preview.export",
      domain,
      data: parsedImport,
      ts: new Date().toISOString(),
    };
    emitImportUiEvent("import.preview.hub.requested", payload);
    await exportToHubIfEnabled(payload);
    if (typeof onConfirmAction === "function") onConfirmAction(payload);
  };

  // ---------------------------------------------------------------------------
  // RENDERERS
  // ---------------------------------------------------------------------------
  const renderContextChips = () => {
    const chips = [];
    if (Array.isArray(context.ingredients) && context.ingredients.length > 0) {
      chips.push(
        <div key="ingredients" className="flex flex-wrap gap-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Ingredients:</span>
          {context.ingredients.map((ing) => (
            <Badge key={ing}>{ing}</Badge>
          ))}
        </div>
      );
    }
    if (Array.isArray(context.methods) && context.methods.length > 0) {
      chips.push(
        <div key="methods" className="flex flex-wrap gap-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Methods:</span>
          {context.methods.map((m) => (
            <Badge key={m}>{m}</Badge>
          ))}
        </div>
      );
    }
    if (Array.isArray(context.equipment) && context.equipment.length > 0) {
      chips.push(
        <div key="equipment" className="flex flex-wrap gap-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Equipment:</span>
          {context.equipment.map((e) => (
            <Badge key={e}>{e}</Badge>
          ))}
        </div>
      );
    }
    if (Array.isArray(context.seasonality) && context.seasonality.length > 0) {
      chips.push(
        <div key="seasonality" className="flex flex-wrap gap-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Seasonality:</span>
          {context.seasonality.map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
        </div>
      );
    }
    if (Array.isArray(context.tags) && context.tags.length > 0) {
      chips.push(
        <div key="tags" className="flex flex-wrap gap-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Tags:</span>
          {context.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      );
    }

    if (chips.length === 0) {
      return <p className="text-xs text-slate-400">No context intelligence extracted.</p>;
    }

    return <div className="flex flex-col gap-2">{chips}</div>;
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
      <div className="w-full max-w-3xl max-h-[90vh] bg-white rounded-2xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Import preview</p>
            <h2 className="text-lg font-semibold leading-tight">{title}</h2>
            <p className="text-xs text-slate-400">
              Domain: <span className="font-medium text-slate-600">{domain}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full bg-slate-100 hover:bg-slate-200 w-7 h-7 flex items-center justify-center text-slate-600 text-sm"
            aria-label="Close preview"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* context */}
          <section>
            <h3 className="text-sm font-semibold mb-2">Context intelligence</h3>
            {renderContextChips()}
          </section>

          {/* sessions */}
          <section>
            <h3 className="text-sm font-semibold mb-2">Sessions SSA can create</h3>
            {sessions.length === 0 ? (
              <p className="text-xs text-slate-400">
                This import didn&apos;t produce any sessions. You can still send it to inventory/storehouse.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sessions.map((s, idx) => (
                  <li key={idx} className="border rounded-lg p-3 bg-slate-50/70">
                    <p className="text-sm font-medium">
                      {s.label || s.title || `Session ${idx + 1}`}{" "}
                      <Badge>{s.type || "session"}</Badge>
                    </p>
                    {Array.isArray(s.steps) && s.steps.length > 0 ? (
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                        {s.steps.slice(0, 3).map((st, i) => (typeof st === "string" ? st : st.text || "")).join(" • ")}
                        {s.steps.length > 3 ? " …" : ""}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* inventory/storehouse */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="text-sm font-semibold mb-2">Inventory changes</h3>
              {inventoryChanges.length === 0 ? (
                <p className="text-xs text-slate-400">No inventory changes in this import.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {inventoryChanges.map((ic, idx) => (
                    <li key={idx} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                      <span>{ic.item || ic.name || ic.sku || "Unknown item"}</span>
                      <span className="text-slate-500">
                        {ic.qty || ic.quantity || ic.amount || 1} {ic.unit || ic.units || ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold mb-2">Storehouse changes</h3>
              {storehouseChanges.length === 0 ? (
                <p className="text-xs text-slate-400">No storehouse changes in this import.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {storehouseChanges.map((sc, idx) => (
                    <li key={idx} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                      <span>{sc.item || sc.name || "Unknown item"}</span>
                      <span className="text-slate-500">
                        {sc.targetQty || sc.qty || sc.quantity || 0} {sc.unit || "ea"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* warnings */}
          {warnings.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2 text-amber-700">Warnings</h3>
              <ul className="list-disc pl-5 text-xs text-amber-700 space-y-1">
                {warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t bg-slate-50 flex flex-wrap gap-2 items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={handleSaveFavorite}
              className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm hover:bg-slate-800"
            >
              Save as favorite
            </button>
            <button
              onClick={handleSchedule}
              className="px-3 py-2 rounded-lg bg-purple-600 text-white text-sm hover:bg-purple-500"
            >
              Schedule
            </button>
            {inventoryChanges.length > 0 ? (
              <button
                onClick={handleSendToInventory}
                className="px-3 py-2 rounded-lg bg-slate-200 text-slate-900 text-sm hover:bg-slate-300"
              >
                Send to Inventory
              </button>
            ) : null}
            {storehouseChanges.length > 0 ? (
              <button
                onClick={handleSendToStorehouse}
                className="px-3 py-2 rounded-lg bg-slate-200 text-slate-900 text-sm hover:bg-slate-300"
              >
                Send to Storehouse
              </button>
            ) : null}
          </div>
          <div className="flex gap-2 items-center">
            <button
              onClick={handleExportToHub}
              className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500"
            >
              Export to Hub
            </button>
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg bg-white text-slate-700 border border-slate-200 text-sm hover:bg-slate-100"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
