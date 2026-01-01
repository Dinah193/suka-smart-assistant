// C:\Users\larho\suka-smart-assistant\src\import\ImportSettings.jsx
// User import settings (auto-check inventory, auto-schedule)
// -----------------------------------------------------------------------------
// WHERE THIS FITS
// - ImportLanding.jsx shows a small settings panel → **this file**
// - These settings tell the Import pipeline HOW aggressive it should be:
//    • auto-check inventory on import
//    • auto-schedule sessions from imports
//    • show preview modal after import
//    • trust site allowlist (skip confirm for known sites)
//    • auto-export to Hub (only if familyFundMode=true)
// - Downstream, ImportService.js, ImportRouter.js, ImportNormalizer.js
//   should read these preferences (from localStorage or a small settings store)
//   to decide how to process each import.
//
// EVENT-DRIVEN
// - Emits: import.settings.updated
//   { type, ts, source: "import.settings", data: { ...settings } }
//
// FORWARD-THINKING
// - New domains (preservation, animal, storehouse) are already implied —
//   settings apply to all imports unless a domain overrides them.
// - You can extend SETTINGS_KEYS below without changing the component logic.
//
// PERSISTENCE
// - Uses localStorage key: "ssa.import.settings"
// - Defensive: if localStorage is not available, falls back to in-memory.
// -----------------------------------------------------------------------------

import React, { useEffect, useState } from "react";
import eventBus from "../services/eventBus";
import config from "../config";

// -----------------------------------------------------------------------------
// Default settings
// -----------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  autoCheckInventory: true, // run inventory check right after import
  autoScheduleSessions: false, // create schedule requests automatically
  showPreviewModal: true, // show ImportPreviewModal by default
  trustSiteAllowList: true, // skip extra confirm for sites in siteAllowList.json
  autoExportToHub: false, // only meaningful if familyFundMode=true
};

// LocalStorage key
const LS_KEY = "ssa.import.settings";

// -----------------------------------------------------------------------------
// Hub export helper (for when user toggles autoExportToHub ON)
// Settings don't change household data directly, but enabling auto-export
// affects future data-changing events, so we mirror this to the Hub as telemetry.
// -----------------------------------------------------------------------------
async function exportToHubIfEnabled(settings) {
  try {
    const flags =
      (config && (config.featureFlags || (typeof config === "function" ? config().featureFlags : {}))) ||
      config.featureFlags ||
      {};
    const familyFundMode = flags.familyFundMode === true || flags.familyFundMode === "true";
    if (!familyFundMode) return;
    if (!settings?.autoExportToHub) return;

    const { default: HubPacketFormatter } = await import("../services/HubPacketFormatter.js");
    const { default: FamilyFundConnector } = await import("../services/FamilyFundConnector.js");

    const packet = HubPacketFormatter.format({
      kind: "import.settings.updated",
      ts: new Date().toISOString(),
      data: settings,
    });
    await FamilyFundConnector.send(packet);
  } catch (err) {
    console.warn("[ImportSettings] Hub telemetry failed (silent):", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// Safe storage utils
// -----------------------------------------------------------------------------
function loadSettings() {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    console.warn("[ImportSettings] failed to load from localStorage:", err);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[ImportSettings] failed to save to localStorage:", err);
  }
}

// -----------------------------------------------------------------------------
// Event emitter
// -----------------------------------------------------------------------------
function emitSettingsUpdated(settings) {
  eventBus.emit("import.settings.updated", {
    type: "import.settings.updated",
    ts: new Date().toISOString(),
    source: "import.settings",
    data: settings,
  });
}

// -----------------------------------------------------------------------------
// Toggle component (simple, inline)
// -----------------------------------------------------------------------------
function Toggle({ label, description, checked, onChange, disabled = false }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <span className="pt-1">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-purple-600 focus:ring-purple-500"
          checked={checked}
          onChange={(e) => onChange?.(e.target.checked)}
          disabled={disabled}
        />
      </span>
      <span className="flex flex-col gap-[2px]">
        <span className={`text-sm ${disabled ? "text-slate-400" : "text-slate-900"}`}>{label}</span>
        {description ? <span className="text-xs text-slate-400 leading-snug">{description}</span> : null}
      </span>
    </label>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------
export default function ImportSettings({ compact = false }) {
  const [settings, setSettings] = useState(() => loadSettings());
  const [familyFundMode, setFamilyFundMode] = useState(() => {
    const flags =
      (config && (config.featureFlags || (typeof config === "function" ? config().featureFlags : {}))) ||
      config.featureFlags ||
      {};
    return flags.familyFundMode === true || flags.familyFundMode === "true";
  });

  // keep an eye on external changes to config (rare, but could be hot-loaded)
  useEffect(() => {
    const flags =
      (config && (config.featureFlags || (typeof config === "function" ? config().featureFlags : {}))) ||
      config.featureFlags ||
      {};
    setFamilyFundMode(flags.familyFundMode === true || flags.familyFundMode === "true");
  }, []);

  const updateSetting = (key, value) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next);
    emitSettingsUpdated(next);
    // only export when user enables Hub auto-export
    if (key === "autoExportToHub" && value === true) {
      exportToHubIfEnabled(next);
    }
  };

  // this panel is used in ImportLanding header — keep it neat
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white/80 ${
        compact ? "p-2 w-[240px]" : "p-3 w-[260px]"
      } shadow-sm`}
    >
      {!compact ? (
        <div className="mb-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Import settings</p>
          <p className="text-xs text-slate-500">Control how SSA handles new imports.</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <Toggle
          label="Auto-check inventory"
          description="After an import, check for missing or low items."
          checked={settings.autoCheckInventory}
          onChange={(v) => updateSetting("autoCheckInventory", v)}
        />

        <Toggle
          label="Auto-schedule sessions"
          description="If the import had sessions, create schedule requests."
          checked={settings.autoScheduleSessions}
          onChange={(v) => updateSetting("autoScheduleSessions", v)}
        />

        <Toggle
          label="Show preview modal"
          description="After import, show what SSA parsed and let me choose action."
          checked={settings.showPreviewModal}
          onChange={(v) => updateSetting("showPreviewModal", v)}
        />

        <Toggle
          label="Trust allowed sites"
          description="If the source is in siteAllowList.json, skip extra confirm."
          checked={settings.trustSiteAllowList}
          onChange={(v) => updateSetting("trustSiteAllowList", v)}
        />

        <Toggle
          label="Auto-export to Hub"
          description={
            familyFundMode
              ? "When imports change inventory/storehouse/sessions, mirror to SVFFH."
              : "Enable familyFundMode to export to Hub."
          }
          checked={settings.autoExportToHub && familyFundMode}
          onChange={(v) => updateSetting("autoExportToHub", v)}
          disabled={!familyFundMode}
        />
      </div>

      {!compact ? (
        <p className="mt-3 text-[10px] text-slate-400 leading-snug">
          These settings are saved locally in your browser ({LS_KEY}). Other SSA modules (ImportService,
          automation.runtime) will read them to decide what to do automatically.
        </p>
      ) : null}
    </div>
  );
}
