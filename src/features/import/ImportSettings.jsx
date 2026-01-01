// C:\Users\larho\suka-smart-assistant\src\features\import\ImportSettings.jsx
// Settings / preferences panel for the Import system
// -----------------------------------------------------------------------------
// UPDATED to 10/30 scope:
// - cleaning: zone routines, declutter, recurring schedules
// - garden: planning, care/maintenance, harvest → inventory/preserving
// - storehouse: stock planning with grocery-section inspiration
// - meals: recipes + meal plans
// - animals: acquisition, care, butchery
// - inventory: scan • compare • trust + manual updates
//
// WHY THIS EXISTS
// - You now have an import stack: ImportNormalizer, ImportService, ImportQueueManager,
//   ImportPreviewCard, ImportPreviewModal, ImportLanding.
// - This file gives USERS control over import behavior, not just the system.
//
// KEY REQUIREMENTS FULFILLED
// ✓ users can save their own favorite sessions and schedules
// ✓ must support reverse generation
// ✓ integrate shared orchestration
// ✓ reflect project chats: bookmarklet, pinterest → planner, scan-compare-trust,
//   garden/seed, co-op planning, auto-queue, auto-open preview, storehouse vs inventory,
//   animal acquisition → butchery.
//
// -----------------------------------------------------------------------------
// storage keys
const SETTINGS_KEY = "suka.import.settings.v1";

import React, { useEffect, useState, useCallback } from "react";
import { ImportService } from "./ImportService";
import { ImportQueueManager } from "./ImportQueueManager";

const isBrowser = typeof window !== "undefined";

const DEFAULT_SETTINGS = {
  autoOpenPreview: true,
  autoSaveFavorite: false,
  autoSchedule: false,
  autoScheduleRule: "once+5min", // future: cron-like
  // what to do with pinterest boards BY DEFAULT
  pinterestDefault: "mealPlan", // mealPlan | gardenPlan | storehouseGoal
  reverseIncludeShare: true,
  reverseHubTarget: "family-fund-hub",
  // which sources are allowed in this device
  sources: {
    bookmarklet: true,
    file: true,
    pinterest: true,
    "scan-compare-trust": true,
    "social-recipe": true,
    // NEW: explicit garden & household sources
    "garden-plan": true,
    "garden-care": true,
    "garden-harvest": true,
    "cleaning-plan": true,
    storehouse: true,
    animals: true,
  },
  // domain-specific autos
  domainAutos: {
    cleaningSession: {
      autoSchedule: true,
      rule: "daily@9",
    },
    gardenPlan: {
      autoSchedule: false,
      rule: "once+5min",
    },
    gardenCare: {
      autoSchedule: true,
      rule: "daily@9",
    },
    gardenHarvest: {
      autoSchedule: true,
      rule: "once+5min",
      // harvest → inventory/cooking
      forwardToInventory: true,
      forwardToCooking: true,
    },
    storehouseGoal: {
      autoSchedule: false,
    },
    animalPlan: {
      autoSchedule: false,
    },
  },
  // import landing layout prefs
  showQuickAdd: true,
};

function loadSettings() {
  if (!isBrowser) return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

function emit(eventName, detail = {}) {
  if (isBrowser) {
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
  try {
    const bus = isBrowser ? window.__suka?.eventBus : null;
    if (bus?.emit) bus.emit(eventName, detail);
  } catch {
    // ignore
  }
}

export default function ImportSettings() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [dirty, setDirty] = useState(false);
  const [clearing, setClearing] = useState(false);

  // auto-react to imports
  useEffect(() => {
    if (!isBrowser) return undefined;

    const handler = (ev) => {
      const { normalized } = ev.detail || {};
      if (!normalized) return;
      const current = loadSettings();

      // 1) global auto-open
      if (current.autoOpenPreview) {
        window.dispatchEvent(new CustomEvent("import.preview.open", { detail: { item: normalized } }));
      }

      // 2) global auto-save favorite
      if (current.autoSaveFavorite) {
        ImportService.saveAsFavorite(normalized);
      }

      // 3) global auto-schedule
      if (current.autoSchedule) {
        const schedule = buildScheduleFromRule(current.autoScheduleRule, normalized);
        window.dispatchEvent(
          new CustomEvent("automation.schedule.request", {
            detail: {
              source: "import.settings.auto",
              normalized,
              schedule,
              session: {
                domain: normalized.type,
                action: "run-imported",
                payload: normalized,
              },
            },
          }),
        );
      }

      // 4) domain-specific autos (cleaning, garden-care, harvest, storehouse, animal)
      const domainAutos = current.domainAutos || {};
      const domainCfg = domainAutos[normalized.type];
      if (domainCfg?.autoSchedule) {
        const schedule = buildScheduleFromRule(domainCfg.rule || "once+5min", normalized);
        window.dispatchEvent(
          new CustomEvent("automation.schedule.request", {
            detail: {
              source: `import.settings.domain.${normalized.type}`,
              normalized,
              schedule,
              session: {
                domain: normalized.type,
                action: "run-imported",
                payload: normalized,
              },
            },
          }),
        );
      }

      // 5) harvest forwarders (this came up in your chats)
      if (normalized.type === "gardenHarvest") {
        // forward to inventory board
        if (domainAutos?.gardenHarvest?.forwardToInventory) {
          window.dispatchEvent(
            new CustomEvent("inventory.harvest.imported", {
              detail: { gardenHarvest: normalized },
            }),
          );
        }
        // forward to cooking / preserving
        if (domainAutos?.gardenHarvest?.forwardToCooking) {
          window.dispatchEvent(
            new CustomEvent("cooking.garden-harvest.imported", {
              detail: { gardenHarvest: normalized },
            }),
          );
        }
      }
    };

    window.addEventListener("import.service.completed", handler);
    window.addEventListener("import.queue.done", handler);

    return () => {
      window.removeEventListener("import.service.completed", handler);
      window.removeEventListener("import.queue.done", handler);
    };
  }, []);

  const updateSetting = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      setDirty(true);
      return next;
    });
  }, []);

  const updateSourceSetting = useCallback((key, value) => {
    setSettings((prev) => {
      const next = {
        ...prev,
        sources: {
          ...prev.sources,
          [key]: value,
        },
      };
      setDirty(true);
      return next;
    });
  }, []);

  const updateDomainAuto = useCallback((domainKey, field, value) => {
    setSettings((prev) => {
      const prevDomain = prev.domainAutos || {};
      const prevCfg = prevDomain[domainKey] || {};
      const next = {
        ...prev,
        domainAutos: {
          ...prevDomain,
          [domainKey]: {
            ...prevCfg,
            [field]: value,
          },
        },
      };
      setDirty(true);
      return next;
    });
  }, []);

  const save = useCallback(() => {
    const next = { ...settings };
    saveSettings(next);
    emit("import.settings.changed", { settings: next });
    setDirty(false);
  }, [settings]);

  const reset = useCallback(() => {
    saveSettings(DEFAULT_SETTINGS);
    setSettings({ ...DEFAULT_SETTINGS });
    emit("import.settings.changed", { settings: { ...DEFAULT_SETTINGS } });
    setDirty(false);
  }, []);

  const clearData = useCallback(async () => {
    setClearing(true);
    try {
      // clear recents
      if (isBrowser) {
        window.localStorage.removeItem("suka.import.recents.v1");
      }
      // clear favorites
      if (isBrowser) {
        window.localStorage.removeItem("suka.import.favorites.v1");
      }
      // clear queue
      ImportQueueManager.clear?.();
      emit("import.settings.cleared", {});
    } finally {
      setClearing(false);
    }
  }, []);

  // helpers
  function buildScheduleFromRule(rule, item) {
    // simple rules only right now
    if (rule === "once+5min") {
      return {
        id: `import-${item.id}-once5`,
        frequency: "once",
        runAt: Date.now() + 5 * 60 * 1000,
      };
    }
    if (rule === "daily@9") {
      const now = new Date();
      const runAt = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        9,
        0,
        0,
      ).getTime();
      return {
        id: `import-${item.id}-daily9`,
        frequency: "daily",
        runAt,
      };
    }
    // fallback
    return {
      id: `import-${item.id}-once`,
      frequency: "once",
      runAt: Date.now() + 2 * 60 * 1000,
    };
  }

  return (
    <div className="w-full h-full flex flex-col gap-4 rounded-xl bg-white/80 border border-slate-200 p-5 shadow-sm">
      {/* header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">Import Settings</div>
          <div className="text-xs text-slate-500">
            Control how imported data flows into Meals, Cleaning, Garden, Storehouse, Animals, and Inventory planners.
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            disabled={!dirty}
          >
            Save changes
          </button>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            Reset
          </button>
        </div>
      </div>

      {/* content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* behavior */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4 flex flex-col gap-3">
          <div className="text-xs font-semibold text-slate-700">Behavior</div>

          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.autoOpenPreview}
              onChange={(e) => updateSetting("autoOpenPreview", e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Auto-open preview after import
              <span className="block text-slate-400 text-[10px]">
                Opens ImportPreviewModal.jsx whenever something is imported.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.autoSaveFavorite}
              onChange={(e) => updateSetting("autoSaveFavorite", e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Auto-save user-owned favorite
              <span className="block text-slate-400 text-[10px]">
                Ensures users can save their own sessions/schedules — even system-generated ones.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.autoSchedule}
              onChange={(e) => updateSetting("autoSchedule", e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Auto-schedule imported items
              <span className="block text-slate-400 text-[10px]">
                Emits <code className="text-[10px] bg-slate-100 px-1 rounded">automation.schedule.request</code> on
                import.
              </span>
            </span>
          </label>

          {settings.autoSchedule && (
            <div className="flex flex-col gap-1 text-xs">
              <label className="text-slate-500">Auto-schedule rule</label>
              <select
                value={settings.autoScheduleRule}
                onChange={(e) => updateSetting("autoScheduleRule", e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
              >
                <option value="once+5min">Run once 5 minutes after import</option>
                <option value="daily@9">Run daily at 9 AM</option>
              </select>
            </div>
          )}
        </div>

        {/* source mapping */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4 flex flex-col gap-3">
          <div className="text-xs font-semibold text-slate-700">Source mapping</div>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources.bookmarklet}
              onChange={(e) => updateSourceSetting("bookmarklet", e.target.checked)}
            />
            Enable Bookmarklet imports
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources.file}
              onChange={(e) => updateSourceSetting("file", e.target.checked)}
            />
            Enable File imports
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources.pinterest}
              onChange={(e) => updateSourceSetting("pinterest", e.target.checked)}
            />
            Enable Pinterest → Planner imports
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources["scan-compare-trust"]}
              onChange={(e) => updateSourceSetting("scan-compare-trust", e.target.checked)}
            />
            Enable Scan • Compare • Trust imports
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources["social-recipe"]}
              onChange={(e) => updateSourceSetting("social-recipe", e.target.checked)}
            />
            Enable Social Recipe imports
          </label>

          {/* NEW domain sources */}
          <label className="flex items-center gap-2 text-xs text-slate-700 pt-1 border-t border-slate-100">
            <input
              type="checkbox"
              checked={settings.sources["cleaning-plan"]}
              onChange={(e) => updateSourceSetting("cleaning-plan", e.target.checked)}
            />
            Enable Cleaning Plan imports
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources["garden-plan"]}
              onChange={(e) => updateSourceSetting("garden-plan", e.target.checked)}
            />
            Enable Garden Plan imports
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources["garden-care"]}
              onChange={(e) => updateSourceSetting("garden-care", e.target.checked)}
            />
            Enable Garden Care imports
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources["garden-harvest"]}
              onChange={(e) => updateSourceSetting("garden-harvest", e.target.checked)}
            />
            Enable Garden Harvest imports
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources.storehouse}
              onChange={(e) => updateSourceSetting("storehouse", e.target.checked)}
            />
            Enable Storehouse Goal / Stock Plan imports
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.sources.animals}
              onChange={(e) => updateSourceSetting("animals", e.target.checked)}
            />
            Enable Animal Plan / Butchery imports
          </label>

          <div className="flex flex-col gap-1 text-xs mt-2">
            <label className="text-slate-500">Pinterest default domain</label>
            <select
              value={settings.pinterestDefault}
              onChange={(e) => updateSetting("pinterestDefault", e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
            >
              <option value="mealPlan">Meal Plan</option>
              <option value="gardenPlan">Garden Plan</option>
              <option value="storehouseGoal">Storehouse Goal</option>
            </select>
            <p className="text-[10px] text-slate-400">
              Keeps your boards from scattering into the wrong planner pages.
            </p>
          </div>
        </div>

        {/* domain-specific automation */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4 flex flex-col gap-3">
          <div className="text-xs font-semibold text-slate-700">Domain automations</div>
          <p className="text-[10px] text-slate-400">
            These rules mirror what you said in chat: cleaning and garden-care should often be auto-scheduled (daily /
            weekly), harvest should forward to inventory/preserving, others stay manual.
          </p>

          {/* cleaning */}
          <div className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.domainAutos.cleaningSession?.autoSchedule ?? false}
              onChange={(e) => updateDomainAuto("cleaningSession", "autoSchedule", e.target.checked)}
            />
            <span className="flex-1">
              Auto-schedule cleaning imports
              <span className="block text-[10px] text-slate-400">Ideal for room/zone routines.</span>
            </span>
            <select
              value={settings.domainAutos.cleaningSession?.rule || "daily@9"}
              onChange={(e) => updateDomainAuto("cleaningSession", "rule", e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700"
            >
              <option value="daily@9">Daily @ 9 AM</option>
              <option value="once+5min">Run once in 5 min</option>
            </select>
          </div>

          {/* garden care */}
          <div className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.domainAutos.gardenCare?.autoSchedule ?? false}
              onChange={(e) => updateDomainAuto("gardenCare", "autoSchedule", e.target.checked)}
            />
            <span className="flex-1">
              Auto-schedule garden care
              <span className="block text-[10px] text-slate-400">Watering, weeding, pests.</span>
            </span>
            <select
              value={settings.domainAutos.gardenCare?.rule || "daily@9"}
              onChange={(e) => updateDomainAuto("gardenCare", "rule", e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700"
            >
              <option value="daily@9">Daily @ 9 AM</option>
              <option value="once+5min">Run once in 5 min</option>
            </select>
          </div>

          {/* garden harvest */}
          <div className="flex flex-col gap-1 text-xs">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.domainAutos.gardenHarvest?.autoSchedule ?? false}
                onChange={(e) => updateDomainAuto("gardenHarvest", "autoSchedule", e.target.checked)}
              />
              <span className="flex-1">
                Auto-schedule garden harvest imports
                <span className="block text-[10px] text-slate-400">So preserving tasks can fire automatically.</span>
              </span>
              <select
                value={settings.domainAutos.gardenHarvest?.rule || "once+5min"}
                onChange={(e) => updateDomainAuto("gardenHarvest", "rule", e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700"
              >
                <option value="once+5min">Run once in 5 min</option>
                <option value="daily@9">Daily @ 9 AM</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-[10px] text-slate-600">
              <input
                type="checkbox"
                checked={settings.domainAutos.gardenHarvest?.forwardToInventory ?? true}
                onChange={(e) => updateDomainAuto("gardenHarvest", "forwardToInventory", e.target.checked)}
              />
              Forward harvest to Inventory
            </label>
            <label className="flex items-center gap-2 text-[10px] text-slate-600">
              <input
                type="checkbox"
                checked={settings.domainAutos.gardenHarvest?.forwardToCooking ?? true}
                onChange={(e) => updateDomainAuto("gardenHarvest", "forwardToCooking", e.target.checked)}
              />
              Forward harvest to Cooking / Preserving
            </label>
          </div>

          {/* storehouse goal */}
          <div className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.domainAutos.storehouseGoal?.autoSchedule ?? false}
              onChange={(e) => updateDomainAuto("storehouseGoal", "autoSchedule", e.target.checked)}
            />
            <span className="flex-1">
              Auto-schedule storehouse stock plans
              <span className="block text-[10px] text-slate-400">
                Good when importing grocery-section inspired storehouse templates.
              </span>
            </span>
            <select
              value={settings.domainAutos.storehouseGoal?.rule || "once+5min"}
              onChange={(e) => updateDomainAuto("storehouseGoal", "rule", e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700"
            >
              <option value="once+5min">Run once in 5 min</option>
              <option value="daily@9">Daily @ 9 AM</option>
            </select>
          </div>

          {/* animal plan */}
          <div className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.domainAutos.animalPlan?.autoSchedule ?? false}
              onChange={(e) => updateDomainAuto("animalPlan", "autoSchedule", e.target.checked)}
            />
            <span className="flex-1">
              Auto-schedule animal imports
              <span className="block text-[10px] text-slate-400">
                Useful when you reverse-generate “Generate Animal Plan from Recipes.”
              </span>
            </span>
            <select
              value={settings.domainAutos.animalPlan?.rule || "once+5min"}
              onChange={(e) => updateDomainAuto("animalPlan", "rule", e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700"
            >
              <option value="once+5min">Run once in 5 min</option>
              <option value="daily@9">Daily @ 9 AM</option>
            </select>
          </div>
        </div>

        {/* reverse generation */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4 flex flex-col gap-3">
          <div className="text-xs font-semibold text-slate-700">Reverse generation</div>

          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={settings.reverseIncludeShare}
              onChange={(e) => updateSetting("reverseIncludeShare", e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Include share metadata
              <span className="block text-slate-400 text-[10px]">
                Adds <code className="bg-slate-100 px-1 rounded text-[10px]">share: {'{ canShare: true, ... }'}</code>{" "}
                to reversed payload — useful for “sell it to community.”
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-1 text-xs">
            <label className="text-slate-500">Default hub / marketplace target</label>
            <select
              value={settings.reverseHubTarget}
              onChange={(e) => updateSetting("reverseHubTarget", e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
            >
              <option value="family-fund-hub">Family Fund Hub</option>
              <option value="sacred-village">Sacred Village</option>
              <option value="local-coop">Local Co-op</option>
            </select>
            <p className="text-[10px] text-slate-400">
              Your reversed payloads will be pre-labeled for this destination.
            </p>
          </div>
        </div>

        {/* maintenance / cleanup */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4 flex flex-col gap-3">
          <div className="text-xs font-semibold text-slate-700">Maintenance</div>
          <p className="text-[10px] text-slate-500">
            Clear local caches if imports start to feel “out of sync” across Meal, Cleaning, Garden, Storehouse, Animals,
            Inventory, or the Scan • Compare • Trust flows.
          </p>
          <button
            type="button"
            onClick={clearData}
            className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 ring-1 ring-rose-100 hover:bg-rose-100 disabled:opacity-60"
            disabled={clearing}
          >
            {clearing ? "Clearing..." : "Clear recents, favorites, and queue"}
          </button>
          <p className="text-[10px] text-slate-400">
            This will NOT delete cloud/shared data, only local-device import caches.
          </p>
        </div>
      </div>

      {/* footer status */}
      <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-400">
        <span>Last saved: local device</span>
        {dirty && <span className="text-amber-500">• Unsaved changes</span>}
      </div>
    </div>
  );
}
