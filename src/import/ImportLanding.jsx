// C:\Users\larho\suka-smart-assistant\src\import\ImportLanding.jsx
// "Bring it into Suka" UI for ALL DOMAINS
// -----------------------------------------------------------------------------
// PURPOSE
// - This is the main entry UI for imports in SSA.
// - It is the human-facing "drop it here / paste it here / point to that site" surface.
// - It does NOT do the heavy parsing itself — it delegates to ImportService.
// - It emits events to the shared eventBus so the automation runtime can react
//   (suggest sessions, update inventory, create garden/animal plans, etc.).
// - If familyFundMode is ON, it will also try to export the import metadata to the Hub.
//
// PIPELINE FIT
// 1. User brings source → here (file, URL, pasted data, bookmarklet relay).
// 2. This component calls ImportService.importPayload(...) with { domain, raw, meta }.
// 3. ImportService → ImportNormalizer → domain engines (meals, cleaning, garden, animal, storehouse).
// 4. ImportService re-emits normalized events; we also emit here for UI-level telemetry.
// 5. If household data changed (inventory, storehouse, sessions), we call exportToHubIfEnabled(...)
//    so SSA → (optionally) SVFFH, but SSA still owns the data first.
// -----------------------------------------------------------------------------
// FORWARD-THINKING
// - Supports multi-domain imports out of the box.
// - Adding a new domain = add to DOMAIN_OPTIONS + teach ImportService how to route it.
// - Supports bookmarklet callback (window.__sukaImportPayload) so mobile / browser can send in data.
// - Defensive: catches errors, surfaces to UI, still emits eventBus messages.

import React, { useEffect, useState, useCallback } from "react";
import eventBus from "../services/eventBus";
import ImportService from "./ImportService";
import ImportSettings from "./ImportSettings.jsx";
import config from "../config"; // assume central config accessor (featureFlags, env, etc.)

// -----------------------------------------------------------------------------
// Domain options the user can select from in the UI.
// Extend this list as new SSA domains become importable.
// -----------------------------------------------------------------------------
const DOMAIN_OPTIONS = [
  { id: "auto", label: "Auto-detect", description: "SSA will guess the right domain" },
  { id: "recipe", label: "Meals / Recipes", description: "Cooking sessions, meal plans, inventory links" },
  { id: "cleaning", label: "Cleaning / Declutter", description: "Zone routines, checklists, rotation" },
  { id: "garden", label: "Garden / Seeds", description: "Planting, care, harvest, seasonality" },
  { id: "animal", label: "Animal / Butchery", description: "Acquisition, care, butchery, yield curves" },
  { id: "storehouse", label: "Storehouse / Stock", description: "Long-term goals → inventory execution" },
  { id: "howto", label: "Video / How-to", description: "YT, TikTok, FB — extract steps & equipment" },
];

// -----------------------------------------------------------------------------
// Helper: emit a consistent event payload
// -----------------------------------------------------------------------------
function emitImportEvent(type, source, data = {}) {
  eventBus.emit(type, {
    type,
    ts: new Date().toISOString(),
    source,
    data,
  });
}

// -----------------------------------------------------------------------------
// Helper: optional Hub export
// - We only *attempt* it. If Hub is down/unavailable, we fail silently.
// - Assumes these modules exist in SSA: HubPacketFormatter, FamilyFundConnector.
// -----------------------------------------------------------------------------
async function exportToHubIfEnabled(payload) {
  try {
    const flags = (config && (config.featureFlags || config().featureFlags)) || config.featureFlags || {};
    const familyFundMode = flags.familyFundMode === true || flags["familyFundMode"] === "true";

    if (!familyFundMode) return;

    // Soft-import so we don't blow up in environments without Hub wired
    const { default: HubPacketFormatter } = await import("../services/HubPacketFormatter.js");
    const { default: FamilyFundConnector } = await import("../services/FamilyFundConnector.js");

    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Silent fail — SSA owns the data; Hub is optional
    console.warn("[ImportLanding] Hub export failed (silent):", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------
export default function ImportLanding({ onImportComplete }) {
  const [activeDomain, setActiveDomain] = useState("auto");
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [lastImports, setLastImports] = useState([]);
  const [pastedData, setPastedData] = useState("");
  const [importUrl, setImportUrl] = useState("");

  // ---------------------------------------------------------------------------
  // Handle bookmarklet / external window injection:
  // If a browser bookmarklet or mobile share sheet calls:
  //   window.__sukaImportPayload = { domain?, raw, meta? }
  // we catch it here and process it like any other import.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function handleExternalImport(payload) {
      if (!payload) return;
      processImportPayload(payload, "bookmarklet");
    }

    // Attach to window
    window.__sukaImport = handleExternalImport;

    // Cleanup
    return () => {
      if (window.__sukaImport === handleExternalImport) {
        window.__sukaImport = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Core processor — shared by file, URL, paste, bookmarklet, etc.
  // ---------------------------------------------------------------------------
  const processImportPayload = useCallback(
    async (rawPayload, source = "ui") => {
      setIsImporting(true);
      setError("");
      setSuccess("");

      try {
        const domain = rawPayload.domain || activeDomain || "auto";

        // Emit that user *requested* an import
        emitImportEvent("import.requested", source, {
          domain,
          rawPreview: typeof rawPayload.raw === "string" ? rawPayload.raw.slice(0, 160) : "[non-string]",
        });

        // Call the high-level import service
        const result = await ImportService.importPayload({
          domain,
          raw: rawPayload.raw || rawPayload,
          meta: {
            source,
            uiDomain: activeDomain,
            ts: new Date().toISOString(),
            ...rawPayload.meta,
          },
        });

        // Normalized result — we expect ImportService to give us:
        // { ok: boolean, domain, inferredDomain, normalized, sessions, inventoryChanges, storehouseChanges }
        if (!result || result.ok === false) {
          setError(result?.error || "Import failed — see console.");
          emitImportEvent("import.failed", source, {
            domain,
            error: result?.error || "Unknown failure",
          });
          return;
        }

        // Update local list for the UI
        setLastImports((prev) => {
          const next = [
            {
              id: Date.now().toString(36),
              domain: result.inferredDomain || domain,
              ts: new Date().toISOString(),
              title: result.normalized?.title || result.normalized?.name || rawPayload.meta?.title || "Imported item",
            },
            ...prev,
          ];
          return next.slice(0, 12); // keep it short
        });

        setSuccess("Imported successfully.");

        // Emit success events
        emitImportEvent("import.parsed", source, {
          domain: result.inferredDomain || domain,
          normalized: result.normalized,
          sessions: result.sessions,
          inventoryChanges: result.inventoryChanges,
          storehouseChanges: result.storehouseChanges,
        });

        // If this import caused real household data changes, send to Hub
        if (
          (result.inventoryChanges && result.inventoryChanges.length) ||
          (result.storehouseChanges && result.storehouseChanges.length) ||
          (result.sessions && result.sessions.length)
        ) {
          await exportToHubIfEnabled({
            kind: "import",
            domain: result.inferredDomain || domain,
            data: result,
            ts: new Date().toISOString(),
          });
        }

        // Let parent know
        if (typeof onImportComplete === "function") {
          onImportComplete(result);
        }
      } catch (err) {
        console.error("[ImportLanding] import error:", err);
        setError(err?.message || "Import failed with unexpected error.");
        emitImportEvent("import.failed", source, {
          domain: activeDomain,
          error: err?.message || "Unexpected",
        });
      } finally {
        setIsImporting(false);
      }
    },
    [activeDomain, onImportComplete]
  );

  // ---------------------------------------------------------------------------
  // UI handlers
  // ---------------------------------------------------------------------------
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      await processImportPayload(
        {
          domain: activeDomain,
          raw: text,
          meta: { filename: file.name, size: file.size, kind: "file" },
        },
        "file-upload"
      );
    } catch (err) {
      console.error(err);
      setError("Couldn't read the file.");
    } finally {
      // reset file input
      e.target.value = "";
    }
  };

  const handleUrlSubmit = async (e) => {
    e.preventDefault();
    if (!importUrl.trim()) return;
    await processImportPayload(
      {
        domain: activeDomain,
        raw: importUrl.trim(),
        meta: { kind: "url" },
      },
      "url"
    );
  };

  const handlePasteSubmit = async () => {
    if (!pastedData.trim()) return;
    await processImportPayload(
      {
        domain: activeDomain,
        raw: pastedData.trim(),
        meta: { kind: "paste" },
      },
      "paste"
    );
    setPastedData("");
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="ssa-import-landing flex flex-col gap-6 p-4 md:p-6 lg:p-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bring it into Suka</h1>
          <p className="text-sm text-slate-500">
            Recipes, cleaning routines, garden plans, animal/butchery notes, storehouse goals, and even how-to videos —
            SSA will normalize it and make it actionable.
          </p>
        </div>

        {/* Settings panel for import behavior */}
        <div className="shrink-0">
          <ImportSettings />
        </div>
      </header>

      {/* Domain selector */}
      <section className="flex flex-wrap gap-2">
        {DOMAIN_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setActiveDomain(opt.id)}
            className={`px-3 py-2 rounded-xl border text-sm transition ${
              activeDomain === opt.id
                ? "bg-purple-600 text-white border-purple-600"
                : "bg-white text-slate-800 border-slate-200 hover:border-purple-200 hover:bg-purple-50"
            }`}
            title={opt.description}
          >
            {opt.label}
          </button>
        ))}
      </section>

      {/* Import panels */}
      <section className="grid gap-4 md:grid-cols-3">
        {/* File upload */}
        <div className="border rounded-2xl p-4 bg-white/70 flex flex-col gap-3">
          <h2 className="font-semibold">Upload a file</h2>
          <p className="text-xs text-slate-500">
            JSON, HTML, markdown, CSV from your scan/exports, seed/garden files, household exports.
          </p>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-200 hover:border-purple-200 rounded-xl py-6 cursor-pointer text-center">
            <span className="text-sm mb-1">Drop a file or click to upload</span>
            <span className="text-xs text-slate-400">.json, .txt, .csv, .html</span>
            <input type="file" className="hidden" onChange={handleFileUpload} disabled={isImporting} />
          </label>
          <p className="text-[10px] text-slate-400">
            SSA will try to detect the domain. You selected: <strong>{activeDomain}</strong>
          </p>
        </div>

        {/* URL import */}
        <div className="border rounded-2xl p-4 bg-white/70 flex flex-col gap-3">
          <h2 className="font-semibold">Import from a URL</h2>
          <p className="text-xs text-slate-500">
            Paste a link from Allrecipes, Love & Lemons, YouTube, TikTok, garden sites, or a cleaning blog.
          </p>
          <form onSubmit={handleUrlSubmit} className="flex gap-2">
            <input
              type="url"
              className="flex-1 border rounded-lg px-2 py-2 text-sm"
              placeholder="https://example.com/post/123"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              disabled={isImporting}
              required
            />
            <button
              type="submit"
              className="px-3 py-2 bg-purple-600 text-white rounded-lg text-sm"
              disabled={isImporting || !importUrl.trim()}
            >
              {isImporting ? "Importing..." : "Import"}
            </button>
          </form>
          <p className="text-[10px] text-slate-400">
            SSA will scrape, normalize, and route to the right engine.
          </p>
        </div>

        {/* Paste import */}
        <div className="border rounded-2xl p-4 bg-white/70 flex flex-col gap-3">
          <h2 className="font-semibold">Paste raw data</h2>
          <p className="text-xs text-slate-500">
            Paste JSON, text, or copied steps from a video description. SSA will try to make sense of it.
          </p>
          <textarea
            rows={4}
            className="w-full border rounded-lg px-2 py-2 text-sm"
            placeholder="Paste household data here..."
            value={pastedData}
            onChange={(e) => setPastedData(e.target.value)}
            disabled={isImporting}
          />
          <button
            onClick={handlePasteSubmit}
            className="self-end px-3 py-2 bg-slate-900 text-white rounded-lg text-sm"
            disabled={isImporting || !pastedData.trim()}
          >
            {isImporting ? "Importing..." : "Process paste"}
          </button>
          <p className="text-[10px] text-slate-400">
            Tip: copy a whole YouTube description with ingredients & steps — SSA will turn it into a session.
          </p>
        </div>
      </section>

      {/* Status messages */}
      {(error || success) && (
        <section>
          {error ? (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          ) : null}
          {success ? (
            <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-3 py-2 text-sm">
              {success}
            </div>
          ) : null}
        </section>
      )}

      {/* Recent imports / telemetry */}
      <section className="border rounded-2xl bg-white/50 p-4">
        <h2 className="font-semibold mb-3 text-sm">Recent imports</h2>
        {lastImports.length === 0 ? (
          <p className="text-xs text-slate-400">No imports yet. Upload a file or paste something.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lastImports.map((imp) => (
              <li key={imp.id} className="flex items-center justify-between gap-2 text-sm">
                <div>
                  <p className="font-medium">{imp.title}</p>
                  <p className="text-[10px] text-slate-400">
                    {imp.domain} • {new Date(imp.ts).toLocaleString()}
                  </p>
                </div>
                <span className="text-[10px] uppercase tracking-wide bg-slate-100 rounded px-2 py-1">
                  Imported
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Dev/help notes (can be hidden behind feature flag later) */}
      <section className="text-[11px] text-slate-400">
        <p>
          This panel emits: <code>import.requested</code>, <code>import.parsed</code>, <code>import.failed</code>.
        </p>
        <p>
          For bookmarklet/mobile: call <code>window.__sukaImport({`{ raw: '...', domain: 'recipe' }`})</code>.
        </p>
      </section>
    </div>
  );
}
