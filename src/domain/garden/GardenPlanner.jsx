// C:\Users\larho\suka-smart-assistant\src\domain\garden\GardenPlanner.jsx
// Manages garden plans (with suggested session dates/times), seeds, grow windows by zones,
// care tasks, and harvest logging.
// -----------------------------------------------------------------------------
// ROLE IN SSA PIPELINE
// imports (garden/seed packets, planting guides, pruning videos, animal manure/compost how-to,
// storehouse low-supplies triggers, meal imports that suggest "grow X")
//   → ImportService → normalized garden payloads
//   → GardenPlanner (THIS FILE) lets the user:
//       1. see suggested garden sessions and plantings from imports + storehouse signals
//       2. create a season/zone plan (Beds, Containers, Indoor Starts, Greenhouse)
//       3. attach care schedules (water, fertilize, prune, trellis, harvest)
//       4. emit events to the shared eventBus so the automation runtime can create
//          GardenSessionEngine sessions and calendar tasks
//       5. optionally export to the Hub when familyFundMode=true
//
// WHY THIS MATTERS
// - Your SSA uses garden → inventory/storehouse → meals → preservation loops.
//   This planner is the GARDEN entry point in that loop.
//   Garden harvests → inventory.updated → storehouseGoalEngine → mealSessionGenerator
//   → (optional) preservation.
// - This planner has to understand "grow windows" (frost dates, warm/cool crops) and
//   "zones" (beds, beds by sun, raised beds, hoop house, orchard, animal forage plots).
//
// ASSUMPTIONS
// - src/services/events/eventBus.js
// - src/config/featureFlags.json
// - src/services/hub/HubPacketFormatter.js → formatGardenPlanForHub
// - src/services/hub/FamilyFundConnector.js
// - src/services/imports/ImportIntelligenceService.js → getRecentImports()
// - src/services/garden/GardenSuggestionService.js → suggestGardenFromIntelligence(...)
// - src/services/gardening/GardenPlanStore.js → saveGardenPlan / loadLatestGardenPlan
// - src/services/garden/GardenCalendarService.js (optional) → to compute dates and windows
//
// EMITTED EVENTS (all in { type, ts, source, data } shape):
//  - garden.plan.updated
//  - garden.plan.saved
//  - garden.session.request (automation-friendly)
//  - garden.harvest.logged (when we attach a harvest target)
//  - (from imports) → we react to: import.parsed, inventory.shortage.detected
//
// FORWARD-THINKING EXTENSION POINTS
//  - supports domain: "garden", "seed", "orchard", "forage", "animal-fodder", "preservation"
//  - supports auto-generation of "grow this because storehouse low → lettuce / onions / carrots"
//  - supports mapping to your Hebrew calendar engine (already in your project) by emitting
//    a normalized plan that your calendar can pick up and shift

import React, { useEffect, useMemo, useState } from "react";

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatGardenPlanForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

import { getRecentImports } from "../../services/imports/ImportIntelligenceService";
import { suggestGardenFromIntelligence } from "../../services/gardening/GardenSuggestionService";
import {
  saveGardenPlan,
  loadLatestGardenPlan,
} from "@/services/gardening/GardenPlanStore";

// optional — we call it defensively
let GardenCalendarService = null;
try {
  // eslint-disable-next-line global-require
  GardenCalendarService = require("../../services/garden/GardenCalendarService.js");
} catch (e) {
  GardenCalendarService = null;
}

const SOURCE_ID = "domain.garden.GardenPlanner";

function GardenPlanner() {
  // planBeds: core objects user is editing
  // shape: { id, crop, variety, zone, method, startDate, transplantDate, care, harvestWindow, sourceId, tags, domain }
  const [planBeds, setPlanBeds] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [viewMode, setViewMode] = useState("zones"); // 'zones' | 'calendar' | 'list' | 'sessions'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // init
  useEffect(() => {
    let alive = true;
    async function init() {
      setLoading(true);
      try {
        const [latestPlan, recentImports] = await Promise.all([
          safeLoadLatestGardenPlan(),
          safeGetRecentImports(),
        ]);

        if (!alive) return;

        if (latestPlan && Array.isArray(latestPlan.items)) {
          setPlanBeds(latestPlan.items);
          // load favorites too if plan has children
          if (Array.isArray(latestPlan.favorites)) {
            setFavorites(latestPlan.favorites);
          }
        }

        const suggested = safeSuggestGardenFromIntelligence(recentImports, {
          includeSeeds: true,
          includeOrchard: true,
          includeForage: true,
          includeAnimal: true,
          includeStorehouseLow: true,
        });
        setSuggestions(suggested || []);
      } catch (e) {
        console.warn("[GardenPlanner] init failed", e);
        if (alive) setError("Unable to load garden planner data right now.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    init();

    // subscribe to imports and inventory/storehouse events
    const offImport = eventBus?.on?.("import.parsed", handleImportParsed);
    const offInvShort = eventBus?.on?.(
      "inventory.shortage.detected",
      handleInventoryShortage
    );
    const offStorehouse = eventBus?.on?.("storehouse.low", handleStorehouseLow);
    const offHarvest = eventBus?.on?.(
      "garden.harvest.logged",
      handleGardenHarvestLogged
    );

    return () => {
      alive = false;
      offImport && offImport();
      offInvShort && offInvShort();
      offStorehouse && offStorehouse();
      offHarvest && offHarvest();
    };
  }, []);

  // memo: group by zones / beds
  const itemsByZone = useMemo(() => {
    const zones = {};
    (planBeds || []).forEach((item) => {
      const z = item.zone || "Unassigned";
      if (!zones[z]) zones[z] = [];
      zones[z].push(item);
    });
    return zones;
  }, [planBeds]);

  // memo: if we have GardenCalendarService, produce session windows
  const calendarSessions = useMemo(() => {
    if (!GardenCalendarService || !Array.isArray(planBeds) || !planBeds.length)
      return [];
    try {
      return GardenCalendarService.buildSessionsFromPlan(planBeds);
    } catch (e) {
      console.warn("[GardenPlanner] calendar build failed", e);
      return [];
    }
  }, [planBeds]);

  // ---------------------------------------------------------------------------
  // BUS EVENT HANDLERS
  // ---------------------------------------------------------------------------

  function handleImportParsed(payload) {
    const domain = payload?.data?.domain;
    const normalized = payload?.data?.normalized;
    if (!normalized) return;

    // only care about garden/seed/preservation/animal/storehouse/video with grow info
    if (
      domain === "garden" ||
      domain === "seed" ||
      domain === "orchard" ||
      domain === "forage" ||
      domain === "storehouse" ||
      domain === "video"
    ) {
      const newSugs = safeSuggestGardenFromIntelligence([normalized], {
        includeSeeds: true,
        includeOrchard: true,
        includeForage: true,
        includeAnimal: true,
        includeStorehouseLow: true,
      });
      if (newSugs && newSugs.length) {
        setSuggestions((prev) => [...newSugs, ...prev]);
      }
    }
  }

  function handleInventoryShortage(payload) {
    // inventory.shortage.detected → e.g. "onions", "garlic", "carrots"
    // generate "grow this" suggestions
    try {
      const auto = autoGenerateGrowFromShortage(payload?.data);
      if (auto?.length) {
        setSuggestions((prev) => [...auto, ...prev]);
      }
    } catch (e) {
      console.warn(
        "[GardenPlanner] inventory.shortage.detected handler failed",
        e
      );
    }
  }

  function handleStorehouseLow(payload) {
    // storehouse.low → "pantry staples low" → suggest quick crops / succession
    try {
      const auto = autoGenerateGrowFromStorehouse(payload?.data);
      if (auto?.length) {
        setSuggestions((prev) => [...auto, ...prev]);
      }
    } catch (e) {
      console.warn("[GardenPlanner] storehouse.low handler failed", e);
    }
  }

  function handleGardenHarvestLogged(payload) {
    // when harvest is logged, we can auto-suggest follow-up: succession, preservation
    try {
      const auto = autoGenerateFollowupFromHarvest(payload?.data);
      if (auto?.length) {
        setSuggestions((prev) => [...auto, ...prev]);
      }
    } catch (e) {
      console.warn("[GardenPlanner] garden.harvest.logged handler failed", e);
    }
  }

  // ---------------------------------------------------------------------------
  // UI HANDLERS
  // ---------------------------------------------------------------------------

  function handleAddFromSuggestion(s, targetZone = "Unassigned") {
    if (!s) return;
    const newItem = {
      id: s.id || makeId("garden"),
      crop: s.crop || s.title || "Imported Crop",
      variety: s.variety || "",
      zone: s.zone || targetZone,
      method: s.method || "direct-sow",
      startDate: s.startDate || computeStartDate(),
      care: s.care || buildDefaultCare(s.crop),
      harvestWindow: s.harvestWindow || buildDefaultHarvestWindow(s.crop),
      sourceId: s.sourceId || s.url || null,
      tags: s.tags || [],
      domain: s.domain || "garden",
    };
    const next = [...planBeds, newItem];
    setPlanBeds(next);
    emitEvent("garden.plan.updated", {
      items: next,
      reason: "add-from-suggestion",
    });
  }

  function handleZoneChange(itemId, newZone) {
    const next = planBeds.map((it) =>
      it.id === itemId
        ? {
            ...it,
            zone: newZone,
          }
        : it
    );
    setPlanBeds(next);
    emitEvent("garden.plan.updated", {
      items: next,
      reason: "zone-change",
    });
  }

  function handleStartDateChange(itemId, newDate) {
    const next = planBeds.map((it) =>
      it.id === itemId
        ? {
            ...it,
            startDate: newDate,
          }
        : it
    );
    setPlanBeds(next);
    emitEvent("garden.plan.updated", {
      items: next,
      reason: "date-change",
    });
  }

  async function handleSavePlan(label = "") {
    const planToSave = {
      id: makeId("gardenPlan"),
      label: label || `Garden Plan ${new Date().toLocaleString()}`,
      items: planBeds,
      favorites,
      ts: new Date().toISOString(),
    };
    try {
      await saveGardenPlan(planToSave);
    } catch (e) {
      console.warn("[GardenPlanner] failed to persist garden plan", e);
    }
    setFavorites((prev) => [planToSave, ...prev]);
    const evt = emitEvent("garden.plan.saved", {
      plan: planToSave,
    });
    await exportToHubIfEnabled(evt);
  }

  function handleApplyFavorite(plan) {
    if (!plan || !Array.isArray(plan.items)) return;
    setPlanBeds(plan.items);
    emitEvent("garden.plan.updated", {
      items: plan.items,
      reason: "apply-favorite",
    });
  }

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  function renderToolbar() {
    return (
      <div className="ssa-garden-toolbar flex gap-3 mb-4 items-center">
        <h2 className="text-xl font-semibold">Garden Planner</h2>
        <div className="flex gap-2">
          <button
            className={viewMode === "zones" ? "btn-primary" : "btn-secondary"}
            onClick={() => setViewMode("zones")}
          >
            Zones
          </button>
          <button
            className={
              viewMode === "calendar" ? "btn-primary" : "btn-secondary"
            }
            onClick={() => setViewMode("calendar")}
          >
            Calendar
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
                domain: "garden",
                items: planBeds,
                policy: "zone-window",
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
      <div className="ssa-garden-suggestions mb-4">
        <h3 className="font-semibold mb-2">
          Suggestions (imports, storehouse, harvest follow-up)
        </h3>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <div
              key={s.id || s.title || s.crop}
              className="card p-2 rounded border bg-white"
            >
              <div className="font-medium">{s.crop || s.title}</div>
              {s.tags && s.tags.length ? (
                <div className="text-xs text-gray-500 mb-1">
                  {s.tags.join(" • ")}
                </div>
              ) : null}
              <button
                className="btn-xs btn-primary"
                onClick={() =>
                  handleAddFromSuggestion(s, s.zone || "Unassigned")
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
      <div className="ssa-garden-favorites mb-4">
        <h3 className="font-semibold mb-2">Favorite Garden Plans</h3>
        <div className="flex gap-2 flex-wrap">
          {favorites.map((f) => (
            <button
              key={f.id}
              className="btn-secondary btn-sm"
              onClick={() => handleApplyFavorite(f)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderZonesView() {
    const defaultZones = [
      "Front Beds",
      "Back Beds",
      "Greenhouse / Hoop",
      "Containers / Patio",
      "Orchard / Vines",
      "Animal / Forage",
      "Herbs / Medicinals",
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
                    <div className="text-sm font-medium">{item.crop}</div>
                    <div className="text-xs text-gray-500">
                      {item.variety ? item.variety + " • " : ""}
                      {item.method || "direct-sow"}
                    </div>
                    <div className="text-xs text-gray-400">
                      Start:{" "}
                      <input
                        type="date"
                        className="text-xs border rounded"
                        value={item.startDate?.slice(0, 10) || ""}
                        onChange={(e) =>
                          handleStartDateChange(item.id, e.target.value)
                        }
                      />
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
    if (!planBeds.length) {
      return (
        <p className="text-gray-500 text-sm">No garden items planned yet.</p>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        {planBeds.map((item) => (
          <div
            key={item.id}
            className="border rounded p-2 flex items-center justify-between"
          >
            <div>
              <div className="font-medium">
                {item.crop}
                {item.variety ? " – " + item.variety : ""}
              </div>
              <div className="text-xs text-gray-500">
                {item.zone || "Unassigned"} • {item.method || "direct-sow"} •
                Start {item.startDate ? item.startDate.slice(0, 10) : "TBD"}
              </div>
            </div>
            <select
              className="text-xs border rounded"
              value={item.zone || "Unassigned"}
              onChange={(e) => handleZoneChange(item.id, e.target.value)}
            >
              {[
                "Front Beds",
                "Back Beds",
                "Greenhouse / Hoop",
                "Containers / Patio",
                "Orchard / Vines",
                "Animal / Forage",
                "Herbs / Medicinals",
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

  function renderCalendarView() {
    return (
      <div className="border rounded p-3 bg-white/50">
        <h3 className="font-semibold mb-2">
          Garden Calendar (sessions / windows)
        </h3>
        {calendarSessions && calendarSessions.length ? (
          <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
            {calendarSessions.map((s) => (
              <div key={s.id} className="border rounded p-2 bg-white">
                <div className="font-medium">{s.title}</div>
                <div className="text-xs text-gray-500">
                  {s.start?.slice(0, 10)} → {s.end?.slice(0, 10)} •{" "}
                  {s.zone || "Unassigned"}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            Calendar service not available or no items with dates. Dates will be
            generated when GardenCalendarService is present.
          </p>
        )}
      </div>
    );
  }

  function renderSessionsView() {
    return (
      <div className="border rounded p-3 bg-white/50">
        <h3 className="font-semibold mb-2">Session view</h3>
        <p className="text-xs text-gray-600 mb-2">
          This is the payload your GardenSessionEngine would receive. It will
          create individual sessions for sowing, transplanting, watering,
          fertilizing, pruning, trellising, and harvest windows. It also
          respects your Sabbath/quiet-hours/weather guards.
        </p>
        <pre className="bg-gray-100 rounded p-2 text-xs overflow-x-auto">
          {JSON.stringify(
            {
              domain: "garden",
              items: planBeds,
              policy: "zone-window",
              guards: ["sabbath", "weather", "quiet-hours"],
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
        <p className="text-sm text-gray-500">Loading garden planner…</p>
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
      {viewMode === "calendar" ? renderCalendarView() : null}
      {viewMode === "list" ? renderListView() : null}
      {viewMode === "sessions" ? renderSessionsView() : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// HELPERS
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
    console.warn("[GardenPlanner] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;

    const packet = formatGardenPlanForHub(evtPayload);
    if (!packet) return;

    await FamilyFundConnector.send(packet);
  } catch (e) {
    // Hub is optional — fail silently
    console.warn("[GardenPlanner] Hub export failed (silent)", e);
  }
}

async function safeLoadLatestGardenPlan() {
  try {
    const plan = await loadLatestGardenPlan();
    return plan;
  } catch (e) {
    console.warn("[GardenPlanner] safeLoadLatestGardenPlan failed", e);
    return null;
  }
}

async function safeGetRecentImports() {
  try {
    const imports = await getRecentImports({
      domains: ["garden", "seed", "orchard", "forage", "storehouse", "video"],
      limit: 40,
    });
    return imports;
  } catch (e) {
    console.warn("[GardenPlanner] safeGetRecentImports failed", e);
    return [];
  }
}

function safeSuggestGardenFromIntelligence(intel, opts) {
  try {
    const res = suggestGardenFromIntelligence(intel, opts);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    console.warn("[GardenPlanner] safeSuggestGardenFromIntelligence failed", e);
    return [];
  }
}

function autoGenerateGrowFromShortage(data) {
  if (!data) return [];
  // very simple heuristic:
  // if shortage mentions "onion" → suggest green onions (quick crop)
  // if shortage mentions "carrot" → suggest carrots (cool season)
  const out = [];
  const items = Array.isArray(data.items) ? data.items : [];
  items.forEach((it) => {
    const name = (it.name || it.item || "").toLowerCase();
    if (!name) return;
    if (name.includes("onion")) {
      out.push({
        id: makeId("auto"),
        crop: "Green Onions / Bunching",
        zone: "Front Beds",
        method: "direct-sow",
        tags: ["auto", "from-shortage", "quick-crop"],
        domain: "garden",
      });
    } else if (name.includes("carrot")) {
      out.push({
        id: makeId("auto"),
        crop: "Carrots",
        zone: "Back Beds",
        method: "direct-sow",
        tags: ["auto", "from-shortage", "root"],
        domain: "garden",
      });
    }
  });
  return out;
}

function autoGenerateGrowFromStorehouse(data) {
  if (!data) return [];
  return [
    {
      id: makeId("auto"),
      crop: "Leafy Greens (cut-and-come-again)",
      zone: "Greenhouse / Hoop",
      method: "succession",
      tags: ["auto", "storehouse-low", "fast"],
      domain: "garden",
    },
  ];
}

function autoGenerateFollowupFromHarvest(data) {
  if (!data) return [];
  return [
    {
      id: makeId("auto"),
      crop: "Succession Planting (same bed)",
      zone: data.zone || "Unassigned",
      method: "succession",
      tags: ["auto", "post-harvest"],
      domain: "garden",
    },
  ];
}

function buildDefaultCare(crop) {
  const c = (crop || "").toLowerCase();
  const base = [
    {
      type: "water",
      every: "2d",
    },
  ];
  if (c.includes("tomato") || c.includes("vine")) {
    base.push({ type: "trellis", every: "7d" });
  }
  if (c.includes("greens")) {
    base.push({ type: "harvest", every: "5d" });
  }
  return base;
}

function buildDefaultHarvestWindow(crop) {
  return {
    startOffsetDays: 45,
    endOffsetDays: 75,
    notes: `Estimated harvest for ${crop || "crop"}. Adjust for your zone.`,
  };
}

function computeStartDate() {
  // simple ISO today
  return new Date().toISOString();
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default GardenPlanner;
