// C:\Users\larho\suka-smart-assistant\src\pages\import\settings.jsx
//
// ImportSettingsPage
// -------------------
// This page controls how SSA ingests and normalizes imports from external
// sources (recipes, cleaning plans, garden/seed catalogs, animal/butchery
// resources, storehouse data, and how-to videos).
//
// How this fits into the SSA pipeline
// -----------------------------------
// imports → intelligence → automation → (optional) Hub export
//
// 1. Imports
//    - These settings define which import types are enabled, how aggressive
//      normalization should be, and which domains (cooking, cleaning, etc.)
//      imported items are routed into.
// 2. Intelligence
//    - SSA uses these preferences to build ingredient patterns, method
//      signatures, equipment lists, and seasonality hints from imported
//      content.
// 3. Automation
//    - When settings change, we emit an `import.settings.updated` event so
//      the automation runtime can:
//
//        • re-scan existing imports if needed
//        • adjust future session generation rules
//        • schedule or suggest new sessions based on updated preferences
//
// 4. Optional Hub export
//    - If featureFlags.familyFundMode === true, settings updates are also
//      packaged via HubPacketFormatter and sent with FamilyFundConnector.
//    - SSA still owns the data; the Hub receives a mirrored, formatted view.
//
// This page:
//    - Loads/saves import settings locally (localStorage for now).
//    - Emits consistent events via src/services/eventBus.js.
//    - Calls exportToHubIfEnabled() when settings are saved.
//    - Leaves extension points for new import types and domains.

import React, { useEffect, useMemo, useState } from "react";
import eventBus from "../../services/events/eventBus";
import featureFlags from "../../config/featureFlags";
import HubPacketFormatter from "../../services/hub/HubPacketFormatter";
import FamilyFundConnector from "../../services/hub/FamilyFundConnector";

/**
 * @typedef {"recipe"|"cleaning"|"garden"|"animal"|"storehouse"|"video"} ImportType
 */

/**
 * @typedef {Object} ImportTypeSettings
 * @property {boolean} enabled
 * @property {("low"|"medium"|"high")} normalizationAggressiveness
 * @property {("cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|"auto")} defaultDomain
 */

/**
 * @typedef {Object} ImportSettings
 * @property {Record<ImportType, ImportTypeSettings>} types
 * @property {boolean} autoTagIngredients
 * @property {boolean} autoLinkEquipment
 * @property {boolean} autoDetectSeasonality
 * @property {boolean} reprocessExistingOnChange
 * @property {string} lastUpdatedISO
 */

/** Storage key for local persistence (can be replaced by Dexie later). */
const STORAGE_KEY = "ssa.import.settings.v1";

/** ISO timestamp helper. */
const nowISO = () => new Date().toISOString();

/**
 * Default settings. Forward-thinking: includes all current import types
 * and uses "auto" domain for anything that should be inferred at runtime.
 * New import types can be added here later.
 * @returns {ImportSettings}
 */
function createDefaultSettings() {
  /** @type {Record<ImportType, ImportTypeSettings>} */
  const types = {
    recipe: {
      enabled: true,
      normalizationAggressiveness: "high",
      defaultDomain: "cooking",
    },
    cleaning: {
      enabled: true,
      normalizationAggressiveness: "medium",
      defaultDomain: "cleaning",
    },
    garden: {
      enabled: true,
      normalizationAggressiveness: "medium",
      defaultDomain: "garden",
    },
    animal: {
      enabled: true,
      normalizationAggressiveness: "medium",
      defaultDomain: "animals",
    },
    storehouse: {
      enabled: true,
      normalizationAggressiveness: "low",
      defaultDomain: "storehouse",
    },
    video: {
      enabled: true,
      normalizationAggressiveness: "low",
      defaultDomain: "auto", // let SSA infer from content (recipe vs cleaning vs garden, etc.)
    },
  };

  return {
    types,
    autoTagIngredients: true,
    autoLinkEquipment: true,
    autoDetectSeasonality: true,
    reprocessExistingOnChange: false,
    lastUpdatedISO: nowISO(),
  };
}

/**
 * Load settings from localStorage (or other persistence later).
 * Defensive: returns defaults if anything is malformed or unavailable.
 * @returns {ImportSettings}
 */
function loadSettings() {
  if (typeof window === "undefined") {
    return createDefaultSettings();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultSettings();

    const parsed = JSON.parse(raw);

    // Very lightweight validation – make sure required keys exist.
    if (!parsed || typeof parsed !== "object" || !parsed.types) {
      return createDefaultSettings();
    }

    // Merge with defaults to pick up new import types or flags over time.
    const defaults = createDefaultSettings();

    /** @type {ImportSettings} */
    const merged = {
      ...defaults,
      ...parsed,
      types: {
        ...defaults.types,
        ...(parsed.types || {}),
      },
      lastUpdatedISO: parsed.lastUpdatedISO || nowISO(),
    };

    return merged;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[ImportSettingsPage] Failed to load settings, using defaults:",
      err
    );
    return createDefaultSettings();
  }
}

/**
 * Save settings to localStorage.
 * @param {ImportSettings} settings
 */
function saveSettings(settings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ImportSettingsPage] Failed to save settings:", err);
  }
}

/**
 * Emit an event onto the shared eventBus.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emitEvent(type, source, data) {
  if (!eventBus || typeof eventBus.emit !== "function") {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[ImportSettingsPage] eventBus.emit not available");
    }
    return;
  }

  eventBus.emit({
    type,
    ts: nowISO(),
    source,
    data,
  });
}

/**
 * Export payload to Hub if familyFundMode is enabled.
 * This is intentionally defensive and fails silently if anything is missing.
 * @param {any} payload
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet =
      typeof HubPacketFormatter.formatImportSettings === "function"
        ? HubPacketFormatter.formatImportSettings(payload)
        : HubPacketFormatter.format
        ? HubPacketFormatter.format("import.settings.updated", payload)
        : payload; // as a last resort, send raw payload

    const send =
      typeof FamilyFundConnector.send === "function"
        ? FamilyFundConnector.send
        : typeof FamilyFundConnector.dispatch === "function"
        ? FamilyFundConnector.dispatch
        : null;

    if (!send) return;

    await send(packet);

    emitEvent("session.exported", "import.settings", {
      kind: "import.settings.updated",
      ok: true,
    });
  } catch (err) {
    // Fail silently per requirements, but log in non-prod for debugging.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[ImportSettingsPage] Hub export failed:", err);
    }
  }
}

/**
 * Primary React component for the Import Settings page.
 */
export default function ImportSettingsPage() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  // Compute a simple summary for the header.
  const enabledCount = useMemo(() => {
    return Object.values(settings.types).filter((t) => t.enabled).length;
  }, [settings.types]);

  useEffect(() => {
    if (!isDirty) return;
    setSaveMessage("");
  }, [isDirty]);

  /**
   * Update a top-level boolean flag.
   * @param {"autoTagIngredients"|"autoLinkEquipment"|"autoDetectSeasonality"|"reprocessExistingOnChange"} field
   * @param {boolean} value
   */
  const updateFlag = (field, value) => {
    setSettings((prev) => ({
      ...prev,
      [field]: value,
      lastUpdatedISO: nowISO(),
    }));
    setIsDirty(true);
  };

  /**
   * Update an import type setting.
   * @param {ImportType} type
   * @param {Partial<ImportTypeSettings>} patch
   */
  const updateTypeSettings = (type, patch) => {
    setSettings((prev) => ({
      ...prev,
      types: {
        ...prev.types,
        [type]: {
          ...prev.types[type],
          ...patch,
        },
      },
      lastUpdatedISO: nowISO(),
    }));
    setIsDirty(true);
  };

  const handleReset = () => {
    const defaults = createDefaultSettings();
    setSettings(defaults);
    setIsDirty(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      saveSettings(settings);

      emitEvent("import.settings.updated", "import.settings", {
        settings,
      });

      // Optionally kick off Hub export (fire-and-forget).
      void exportToHubIfEnabled({
        settings,
        updatedAt: settings.lastUpdatedISO || nowISO(),
      });

      setIsDirty(false);
      setSaveMessage("Settings saved.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="import-settings-page">
      {/* Header / summary */}
      <section className="import-settings-header">
        <div>
          <h1 className="page-title">Import & Normalization Settings</h1>
          <p className="page-subtitle">
            Control how Suka Smart Assistant ingests recipes, cleaning plans,
            garden and animal data, storehouse catalogs, and how-to videos.
            These settings feed the household intelligence engine that turns
            imports into sessions.
          </p>
          <div className="import-settings-summary">
            <span className="summary-pill">
              <strong>{enabledCount}</strong> import types enabled
            </span>
            <span className="summary-pill">
              Last updated:{" "}
              {settings.lastUpdatedISO
                ? new Date(settings.lastUpdatedISO).toLocaleString()
                : "—"}
            </span>
          </div>
        </div>

        <div className="import-settings-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleReset}
            disabled={isSaving}
          >
            Reset to defaults
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            {isSaving ? "Saving…" : "Save settings"}
          </button>
          {saveMessage && (
            <span className="save-message" aria-live="polite">
              {saveMessage}
            </span>
          )}
        </div>
      </section>

      {/* Grid: per-type settings */}
      <section className="import-settings-grid">
        <ImportTypeCard
          label="Recipes"
          description="Web recipes, PDFs, and uploads that become cooking sessions."
          typeKey="recipe"
          settings={settings.types.recipe}
          onChange={updateTypeSettings}
        />

        <ImportTypeCard
          label="Cleaning plans"
          description="Checklists, how-to posts, and PDFs that become cleaning sessions."
          typeKey="cleaning"
          settings={settings.types.cleaning}
          onChange={updateTypeSettings}
        />

        <ImportTypeCard
          label="Garden / seeds"
          description="Seed packets, planting guides, and garden layouts that fuel garden & harvest sessions."
          typeKey="garden"
          settings={settings.types.garden}
          onChange={updateTypeSettings}
        />

        <ImportTypeCard
          label="Animal / butchery"
          description="Livestock care guides, cut sheets, and butchery plans."
          typeKey="animal"
          settings={settings.types.animal}
          onChange={updateTypeSettings}
        />

        <ImportTypeCard
          label="Storehouse / catalogs"
          description="Pantry inventories, bulk order catalogs, and storehouse lists."
          typeKey="storehouse"
          settings={settings.types.storehouse}
          onChange={updateTypeSettings}
        />

        <ImportTypeCard
          label="Video / how-to"
          description="Cooking, cleaning, garden, and butchery videos that generate step-based sessions."
          typeKey="video"
          settings={settings.types.video}
          onChange={updateTypeSettings}
        />
      </section>

      {/* Global normalization / intelligence toggles */}
      <section className="import-settings-intelligence">
        <h2>Intelligence & auto-linking</h2>
        <p className="section-subtitle">
          These options control how aggressively SSA turns imports into
          structured intelligence: ingredient graphs, equipment maps, and
          seasonal windows.
        </p>

        <div className="intelligence-grid">
          <FlagToggle
            label="Auto-tag ingredients"
            description="Extract ingredients into a household ingredient graph for cross-recipe insights and inventory linking."
            checked={settings.autoTagIngredients}
            onChange={(v) => updateFlag("autoTagIngredients", v)}
          />

          <FlagToggle
            label="Auto-link equipment"
            description="Detect equipment (pots, pans, ovens, tools) and link them into sessions for better step planning."
            checked={settings.autoLinkEquipment}
            onChange={(v) => updateFlag("autoLinkEquipment", v)}
          />

          <FlagToggle
            label="Auto-detect seasonality"
            description="Infer planting, harvest, and preservation windows from content and your local calendar."
            checked={settings.autoDetectSeasonality}
            onChange={(v) => updateFlag("autoDetectSeasonality", v)}
          />

          <FlagToggle
            label="Reprocess existing imports when settings change"
            description="When you change import rules, SSA can re-run the intelligence pass on past imports."
            checked={settings.reprocessExistingOnChange}
            onChange={(v) => updateFlag("reprocessExistingOnChange", v)}
          />
        </div>

        <p className="section-footnote">
          When you save changes, SSA will emit an{" "}
          <code>import.settings.updated</code> event. The automation runtime can
          listen for this event to re-scan imports, adjust future sessions, or
          schedule maintenance passes.
        </p>
      </section>

      {/* Preview / test area (forward-thinking hook for a real test harness) */}
      <section className="import-settings-preview">
        <h2>Preview: how an import will be treated</h2>
        <p className="section-subtitle">
          This is a simple explanation layer today. Later, this can become an
          interactive test harness that accepts a URL or snippet and shows the
          full import → intelligence → session pipeline.
        </p>

        <div className="preview-card">
          <p className="preview-text">
            For a <strong>recipe URL</strong>:
          </p>
          <ul>
            <li>
              SSA will route it to the <strong>cooking</strong> domain.
            </li>
            <li>
              Ingredients, steps, and equipment will be normalized with{" "}
              <strong>
                {settings.types.recipe.normalizationAggressiveness}
              </strong>{" "}
              aggressiveness.
            </li>
            {settings.autoTagIngredients && (
              <li>
                Ingredients will be <strong>auto-tagged</strong> and linked to
                inventory where possible.
              </li>
            )}
            {settings.autoLinkEquipment && (
              <li>
                Equipment will be <strong>mapped</strong> into session steps to
                avoid conflicts.
              </li>
            )}
            {settings.autoDetectSeasonality && (
              <li>
                SSA will look for <strong>seasonal windows</strong> (e.g., grill
                recipes in summer, soups in winter).
              </li>
            )}
          </ul>

          <button
            type="button"
            className="btn btn-secondary btn-ghost"
            onClick={() => {
              // In the future, this could open a full "Test Import" modal
              // wired to the ImportRouter and inference engine.
              emitEvent(
                "import.settings.preview.requested",
                "import.settings",
                {
                  settings,
                }
              );
              // eslint-disable-next-line no-console
              console.log(
                "[ImportSettingsPage] Preview requested – hook this to ImportRouter test harness."
              );
            }}
          >
            Send preview request to ImportRouter
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Small component: a card for a single import type.
 * @param {{
 *   label: string;
 *   description: string;
 *   typeKey: ImportType;
 *   settings: ImportTypeSettings;
 *   onChange: (type: ImportType, patch: Partial<ImportTypeSettings>) => void;
 * }} props
 */
function ImportTypeCard({ label, description, typeKey, settings, onChange }) {
  const handleToggleEnabled = (e) => {
    onChange(typeKey, { enabled: e.target.checked });
  };

  const handleAggressivenessChange = (e) => {
    const value = e.target.value;
    if (value === "low" || value === "medium" || value === "high") {
      onChange(typeKey, { normalizationAggressiveness: value });
    }
  };

  const handleDomainChange = (e) => {
    const value = /** @type {ImportTypeSettings["defaultDomain"]} */ (
      e.target.value
    );
    onChange(typeKey, { defaultDomain: value });
  };

  return (
    <article className="import-type-card">
      <header className="import-type-header">
        <div>
          <h2>{label}</h2>
          <p className="import-type-description">{description}</p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={handleToggleEnabled}
          />
          <span className="slider" />
          <span className="switch-label">
            {settings.enabled ? "Enabled" : "Disabled"}
          </span>
        </label>
      </header>

      <div className="import-type-body">
        <div className="field-group">
          <label htmlFor={`agg-${typeKey}`} className="field-label">
            Normalization aggressiveness
          </label>
          <select
            id={`agg-${typeKey}`}
            className="field-select"
            value={settings.normalizationAggressiveness}
            onChange={handleAggressivenessChange}
          >
            <option value="low">Low (minimal rewriting)</option>
            <option value="medium">Medium (merge obvious patterns)</option>
            <option value="high">High (aggressive normalization)</option>
          </select>
          <p className="field-hint">
            Controls how much SSA rewrites and merges imported steps, units, and
            ingredient names.
          </p>
        </div>

        <div className="field-group">
          <label htmlFor={`domain-${typeKey}`} className="field-label">
            Default domain routing
          </label>
          <select
            id={`domain-${typeKey}`}
            className="field-select"
            value={settings.defaultDomain}
            onChange={handleDomainChange}
          >
            <option value="auto">Auto (infer from content)</option>
            <option value="cooking">Cooking</option>
            <option value="cleaning">Cleaning</option>
            <option value="garden">Garden</option>
            <option value="animals">Animals</option>
            <option value="preservation">Preservation</option>
            <option value="storehouse">Storehouse</option>
          </select>
          <p className="field-hint">
            SSA will start here when generating sessions. The ImportRouter and
            SessionEngines can override this if content clearly belongs to a
            different domain.
          </p>
        </div>
      </div>
    </article>
  );
}

/**
 * Simple reusable flag toggle card.
 * @param {{
 *   label: string;
 *   description: string;
 *   checked: boolean;
 *   onChange: (value: boolean) => void;
 * }} props
 */
function FlagToggle({ label, description, checked, onChange }) {
  return (
    <div className="flag-toggle-card">
      <div className="flag-toggle-header">
        <h3>{label}</h3>
        <label className="switch">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="slider" />
        </label>
      </div>
      <p className="flag-toggle-description">{description}</p>
    </div>
  );
}
