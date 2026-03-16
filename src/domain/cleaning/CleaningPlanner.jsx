// C:\Users\larho\suka-smart-assistant\src\domain\cleaning\CleaningPlanner.jsx
// Cleaning and decluttering planner
// -----------------------------------------------------------------------------
// ROLE IN SSA PIPELINE
// imports (cleaning routines, zone routines, declutter challenges, garden/yard tasks,
// animal-area cleaning, storehouse organization, video/how-to)
//   → ImportService → normalized cleaning/declutter payloads
//   → CleaningPlanner (THIS FILE) lets user:
//        1. see suggested cleaning/declutter sessions from imports + intelligence
//        2. assemble a daily/weekly plan by zone or by task-type
//        3. save plans as "favorite cleaning sessions/schedules"
//        4. emit events to the shared eventBus so the automation runtime can schedule
//           CleaningSessionEngine.js / CleaningSessionEngine-like logic
//        5. optionally export to the Hub when familyFundMode=true
//
// IMPORTANT
// - SSA and SVFFH are separate. This runs fine even without the Hub.
// - This planner mirrors the MealPlanner style you asked for, but for cleaning.
// - It is event-driven and emits consistent payloads: { type, ts, source, data }.
// - It is forward-thinking: supports new domains (preservation → “sanitize jars room”,
//   animal → “clean butchery area”, storehouse → “relabel bins”).
// - It allows user-owned favorites (recurring requirement).
//
// ASSUMED FILES / SERVICES
// - src/services/events/eventBus.js
// - src/config/featureFlags.json
// - src/services/hub/HubPacketFormatter.js → formatCleaningPlanForHub
// - src/services/hub/FamilyFundConnector.js
// - src/services/imports/ImportIntelligenceService.js → getRecentImports({...})
// - src/services/cleaning/CleaningSuggestionService.js → suggestCleaningFromIntelligence(...)
// - src/services/cleaning/CleaningPlanStore.js → saveCleaningPlan / loadLatestCleaningPlan
//
// If any of these are missing, this component will degrade gracefully.

import React, { useEffect, useMemo, useState } from "react";

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatCleaningPlanForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

import { getRecentImports } from "../../services/imports/ImportIntelligenceService";
import { suggestCleaningFromIntelligence } from "../../services/cleaning/CleaningSuggestionService";
import {
  saveCleaningPlan,
  loadLatestCleaningPlan,
} from "../../services/cleaning/CleaningPlanStore";

const SOURCE_ID = "domain.cleaning.CleaningPlanner";

function CleaningPlanner() {
  // planItems: [{ id, title, zone, frequency, duration, sourceId, tags, domain }]
  const [planItems, setPlanItems] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [viewMode, setViewMode] = useState("zones"); // 'zones' | 'list' | 'sessions'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // init
  useEffect(() => {
    let alive = true;

    async function init() {
      setLoading(true);
      try {
        const [latestPlan, recentImports] = await Promise.all([
          safeLoadLatestCleaningPlan(),
          safeGetRecentImports(),
        ]);

        if (!alive) return;

        if (latestPlan && Array.isArray(latestPlan.items)) {
          setPlanItems(latestPlan.items);
        }

        const suggested = safeSuggestCleaningFromIntelligence(recentImports, {
          includeDeclutter: true,
          includeGarden: true,
          includeAnimal: true,
          includeStorehouse: true,
        });
        setSuggestions(suggested || []);
      } catch (e) {
        console.warn("[CleaningPlanner] init failed", e);
        if (alive) setError("Unable to load cleaning planner data right now.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    init();

    // listen to imports and inventory updates (some cleaning is triggered by inventory/storehouse)
    const offImport = eventBus?.on?.("import.parsed", handleImportParsed);
    const offInv = eventBus?.on?.("inventory.updated", handleInventoryUpdated);
    const offGarden = eventBus?.on?.(
      "garden.harvest.logged",
      handleGardenEvent
    );
    const offPres = eventBus?.on?.(
      "preservation.completed",
      handlePreservationEvent
    );

    return () => {
      alive = false;
      offImport && offImport();
      offInv && offInv();
      offGarden && offGarden();
      offPres && offPres();
    };
  }, []);

  // memo: group by zone
  const itemsByZone = useMemo(() => {
    const zones = {};
    (planItems || []).forEach((item) => {
      const z = item.zone || "Unassigned";
      if (!zones[z]) zones[z] = [];
      zones[z].push(item);
    });
    return zones;
  }, [planItems]);

  // ---------------------------------------------------------------------------
  // EVENT HANDLERS (BUS)
  // ---------------------------------------------------------------------------

  function handleImportParsed(payload) {
    // import.parsed → see if it’s a cleaning/declutter/garden/animal/storehouse type
    const domain = payload?.data?.domain;
    const normalized = payload?.data?.normalized;
    if (!normalized) return;

    // update suggestions
    if (
      domain === "cleaning" ||
      domain === "declutter" ||
      domain === "garden" ||
      domain === "animal" ||
      domain === "storehouse" ||
      domain === "video"
    ) {
      const newSugs = safeSuggestCleaningFromIntelligence([normalized], {
        includeDeclutter: true,
        includeGarden: true,
        includeAnimal: true,
        includeStorehouse: true,
      });
      if (newSugs && newSugs.length) {
        setSuggestions((prev) => [...newSugs, ...prev]);
      }
    }
  }

  function handleInventoryUpdated(payload) {
    // Example: if inventory updated with "raw milk", we might suggest "sanitize milking area"
    try {
      const autoTasks = autoGenerateCleaningFromInventory(payload?.data);
      if (autoTasks?.length) {
        setSuggestions((prev) => [...autoTasks, ...prev]);
      }
    } catch (e) {
      console.warn("[CleaningPlanner] inventory.updated handler failed", e);
    }
  }

  function handleGardenEvent(payload) {
    // garden.harvest.logged → suggest "clean sink", "clean processing area"
    try {
      const autoTasks = autoGenerateCleaningFromGarden(payload?.data);
      if (autoTasks?.length) {
        setSuggestions((prev) => [...autoTasks, ...prev]);
      }
    } catch (e) {
      console.warn("[CleaningPlanner] garden.harvest.logged handler failed", e);
    }
  }

  function handlePreservationEvent(payload) {
    // preservation.completed → “sanitize canning tools”, “wipe pantry shelves”
    try {
      const autoTasks = autoGenerateCleaningFromPreservation(payload?.data);
      if (autoTasks?.length) {
        setSuggestions((prev) => [...autoTasks, ...prev]);
      }
    } catch (e) {
      console.warn(
        "[CleaningPlanner] preservation.completed handler failed",
        e
      );
    }
  }

  // ---------------------------------------------------------------------------
  // UI EVENT HANDLERS
  // ---------------------------------------------------------------------------

  function handleAddItemFromSuggestion(s, targetZone = "Unassigned") {
    if (!s) return;
    const newItem = {
      id: s.id || makeId("clean"),
      title: s.title || "Imported Task",
      zone: s.zone || targetZone,
      frequency: s.frequency || "once",
      duration: s.duration || 15,
      sourceId: s.sourceId || s.url || null,
      tags: s.tags || [],
      domain: s.domain || "cleaning",
    };
    const next = [...planItems, newItem];
    setPlanItems(next);
    emitEvent("cleaning.plan.updated", {
      items: next,
      reason: "add-from-suggestion",
    });
  }

  function handleZoneChange(itemId, newZone) {
    const next = planItems.map((it) =>
      it.id === itemId
        ? {
            ...it,
            zone: newZone,
          }
        : it
    );
    setPlanItems(next);
    emitEvent("cleaning.plan.updated", {
      items: next,
      reason: "zone-change",
    });
  }

  async function handleSavePlan(label = "") {
    const planToSave = {
      id: makeId("cleanPlan"),
      label: label || `Cleaning Plan ${new Date().toLocaleString()}`,
      items: planItems,
      ts: new Date().toISOString(),
    };
    try {
      await saveCleaningPlan(planToSave);
    } catch (e) {
      console.warn("[CleaningPlanner] failed to persist cleaning plan", e);
    }
    setFavorites((prev) => [planToSave, ...prev]);

    const evt = emitEvent("cleaning.plan.saved", {
      plan: planToSave,
    });

    await exportToHubIfEnabled(evt);
  }

  function handleApplyFavoritePlan(fav) {
    if (!fav || !Array.isArray(fav.items)) return;
    setPlanItems(fav.items);
    emitEvent("cleaning.plan.updated", {
      items: fav.items,
      reason: "apply-favorite",
    });
  }

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  function renderToolbar() {
    return (
      <div className="ssa-cleaning-toolbar flex gap-3 mb-4 items-center">
        <h2 className="text-xl font-semibold">
          Cleaning &amp; Decluttering Planner
        </h2>
        <div className="flex gap-2">
          <button
            className={viewMode === "zones" ? "btn-primary" : "btn-secondary"}
            onClick={() => setViewMode("zones")}
          >
            Zones
          </button>
          <button
            className={viewMode === "list" ? "btn-primary" : "btn-secondary"}
            onClick={() => setViewMode("list")}
          >
            List
          </button>
          <button
            className={
              viewMode === "sessions" ? "btn-primary" : "btn-secondary"
            }
            onClick={() => setViewMode("sessions")}
          >
            Sessions
          </button>
        </div>
        <div className="flex gap-2 ml-auto">
          <button className="btn-secondary" onClick={() => handleSavePlan("")}>
            Save as favorite
          </button>
          <button
            className="btn-secondary"
            onClick={() =>
              emitEvent("automation.schedule.request", {
                domain: "cleaning",
                items: planItems,
                policy: "zones-first",
              })
            }
          >
            Send to automation
          </button>
        </div>
      </div>
    );
  }

  function renderSuggestions() {
    if (!suggestions.length) return null;
    return (
      <div className="ssa-cleaning-suggestions mb-4">
        <h3 className="font-semibold mb-2">
          Suggestions (from imports, harvests, preservation)
        </h3>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <div
              key={s.id || s.title}
              className="card p-2 rounded border bg-white"
            >
              <div className="font-medium">{s.title}</div>
              {s.tags && s.tags.length ? (
                <div className="text-xs text-gray-500 mb-1">
                  {s.tags.join(" • ")}
                </div>
              ) : null}
              <button
                className="btn-xs btn-primary"
                onClick={() =>
                  handleAddItemFromSuggestion(s, s.zone || "Unassigned")
                }
              >
                Add to plan
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderFavorites() {
    if (!favorites.length) return null;
    return (
      <div className="ssa-cleaning-favorites mb-4">
        <h3 className="font-semibold mb-2">Favorite Cleaning Plans</h3>
        <div className="flex gap-2 flex-wrap">
          {favorites.map((f) => (
            <button
              key={f.id}
              className="btn-secondary btn-sm"
              onClick={() => handleApplyFavoritePlan(f)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderZonesView() {
    // typical zones you mentioned across SSA:
    const defaultZones = [
      "Entry",
      "Kitchen",
      "Pantry / Storehouse",
      "Living Room",
      "Bedrooms",
      "Bathrooms",
      "Laundry / Utility",
      "Animal / Butchery",
      "Garden / Yard",
      "Unassigned",
    ];

    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {defaultZones.map((z) => (
          <div key={z} className="border rounded p-2 bg-white/50">
            <div className="font-semibold mb-2">{z}</div>
            <div className="flex flex-col gap-1">
              {(itemsByZone[z] || []).map((item) => (
                <div
                  key={item.id}
                  className="border rounded p-1 flex items-center justify-between bg-white"
                >
                  <div>
                    <div className="text-sm font-medium">{item.title}</div>
                    <div className="text-xs text-gray-500">
                      {item.frequency || "once"} • {item.duration || 15} min
                    </div>
                  </div>
                  <select
                    className="text-xs border rounded ml-2"
                    value={item.zone || "Unassigned"}
                    onChange={(e) => handleZoneChange(item.id, e.target.value)}
                  >
                    {defaultZones.map((dz) => (
                      <option key={dz} value={dz}>
                        {dz}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderListView() {
    if (!planItems.length) {
      return (
        <p className="text-gray-500 text-sm">No cleaning tasks planned yet.</p>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        {planItems.map((item) => (
          <div
            key={item.id}
            className="border rounded p-2 flex items-center justify-between"
          >
            <div>
              <div className="font-medium">{item.title}</div>
              <div className="text-xs text-gray-500">
                {item.zone || "Unassigned"} • {item.frequency || "once"} •{" "}
                {item.duration || 15} min
              </div>
            </div>
            <select
              className="text-xs border rounded"
              value={item.zone || "Unassigned"}
              onChange={(e) => handleZoneChange(item.id, e.target.value)}
            >
              {[
                "Entry",
                "Kitchen",
                "Pantry / Storehouse",
                "Living Room",
                "Bedrooms",
                "Bathrooms",
                "Laundry / Utility",
                "Animal / Butchery",
                "Garden / Yard",
                "Unassigned",
              ].map((dz) => (
                <option key={dz} value={dz}>
                  {dz}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    );
  }

  function renderSessionsView() {
    return (
      <div className="border rounded p-3 bg-white/50">
        <h3 className="font-semibold mb-2">Session view</h3>
        <p className="text-xs text-gray-600 mb-2">
          This shows how your cleaning plan would be sent to the
          CleaningSessionEngine / CleaningSessionEngine.js. The engine handles
          sequencing, quiet-hours guard, Sabbath guard, and priority/day-of-week
          logic.
        </p>
        <pre className="bg-gray-100 rounded p-2 text-xs overflow-x-auto">
          {JSON.stringify(
            {
              domain: "cleaning",
              items: planItems,
              policy: "zones-first",
              guards: ["sabbath", "quiet-hours", "weather?"],
            },
            null,
            2
          )}
        </pre>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">Loading cleaning planner…</p>
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {renderToolbar()}
      {error ? <p className="text-red-500 text-sm">{error}</p> : null}
      {renderSuggestions()}
      {renderFavorites()}
      {viewMode === "zones" ? renderZonesView() : null}
      {viewMode === "list" ? renderListView() : null}
      {viewMode === "sessions" ? renderSessionsView() : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

function emitEvent(type, data) {
  const payload = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE_ID,
    data,
  };
  if (eventBus && typeof eventBus.emit === "function") {
    eventBus.emit(type, payload);
  } else {
    console.warn("[CleaningPlanner] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;

    const hubPacket = formatCleaningPlanForHub(evtPayload);
    if (!hubPacket) return;

    await FamilyFundConnector.send(hubPacket);
  } catch (e) {
    console.warn("[CleaningPlanner] Hub export failed (silently)", e);
  }
}

async function safeLoadLatestCleaningPlan() {
  try {
    const plan = await loadLatestCleaningPlan();
    return plan;
  } catch (e) {
    console.warn("[CleaningPlanner] safeLoadLatestCleaningPlan failed", e);
    return null;
  }
}

async function safeGetRecentImports() {
  try {
    const imports = await getRecentImports({
      domains: [
        "cleaning",
        "declutter",
        "garden",
        "animal",
        "storehouse",
        "video",
      ],
      limit: 40,
    });
    return imports;
  } catch (e) {
    console.warn("[CleaningPlanner] safeGetRecentImports failed", e);
    return [];
  }
}

function safeSuggestCleaningFromIntelligence(intel, opts) {
  try {
    const res = suggestCleaningFromIntelligence(intel, opts);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    console.warn(
      "[CleaningPlanner] safeSuggestCleaningFromIntelligence failed",
      e
    );
    return [];
  }
}

function autoGenerateCleaningFromInventory(data) {
  // placeholder heuristic — customize later
  if (!data) return [];
  const list = [];
  if (Array.isArray(data.deltas)) {
    // if storehouse was updated, suggest pantry/storehouse cleaning
    if (data.deltas.some((d) => d.item?.toLowerCase().includes("flour"))) {
      list.push({
        id: makeId("auto"),
        title: "Sweep & wipe pantry floor/shelves",
        zone: "Pantry / Storehouse",
        frequency: "once",
        duration: 10,
        tags: ["auto", "storehouse"],
        domain: "cleaning",
      });
    }
  }
  return list;
}

function autoGenerateCleaningFromGarden(data) {
  if (!data) return [];
  return [
    {
      id: makeId("auto"),
      title: "Clean processing sink / counters",
      zone: "Kitchen",
      frequency: "once",
      duration: 10,
      tags: ["auto", "garden"],
      domain: "cleaning",
    },
  ];
}

function autoGenerateCleaningFromPreservation(data) {
  if (!data) return [];
  return [
    {
      id: makeId("auto"),
      title: "Wipe pantry shelves & label jars",
      zone: "Pantry / Storehouse",
      frequency: "once",
      duration: 12,
      tags: ["auto", "preservation"],
      domain: "cleaning",
    },
  ];
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default CleaningPlanner;
