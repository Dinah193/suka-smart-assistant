// C:\Users\larho\suka-smart-assistant\src\domain\animals\AnimalPlanner.jsx
// Manages & tracks animal acquisition, care, and butchery
// -----------------------------------------------------------------------------
// ROLE IN SSA PIPELINE
// imports (animal/butchery guides, breed info, dairy/milking routines, coop-cleaning,
// fodder/forage plans, video/how-to)
//   → ImportService → normalized animal payloads
//   → AnimalPlanner (THIS FILE) lets the user:
//       1. track WHAT animals they have / intend to acquire (flock/herd builder)
//       2. attach CARE schedules (feed, water, rotate pasture, clean stall, trim, vaccinate)
//       3. attach BUTCHERY / CULL dates (ties back into yieldCurves → inventory/storehouse)
//       4. emit events to shared eventBus so AnimalSessionEngine (companion file) can
//          generate actionable sessions
//       5. optionally export to the Hub when familyFundMode=true
//
// WHY THIS EXISTS
// - Your SSA links animal → butchery → inventory/storehouse → meals/preservation
// - This planner is the animal entry point in that loop, just like GardenPlanner
// - We must support reverse generation: a user can import a butchery schedule from a site
//   and SSA must turn it into an animal plan
//
// EMITS (all consistent shape):
//  - animal.plan.updated
//  - animal.plan.saved
//  - animal.acquired
//  - animal.butcher.request
//  - (optionally) inventory.updated when we LOG an acquisition with starting feed/supplies
//
// PIPELINE FIT
// imports → intelligence → planner (THIS) → session engine → automation → (optional) hub export
//
// ASSUMPTIONS (soft):
// - src/services/events/eventBus.js
// - src/config/featureFlags.json
// - src/services/hub/HubPacketFormatter.js → formatAnimalPlanForHub
// - src/services/hub/FamilyFundConnector.js
// - src/services/imports/ImportIntelligenceService.js → getRecentImports(...)
// - src/services/animals/AnimalSuggestionService.js → suggestAnimalsFromIntelligence(...)
// - src/services/animals/AnimalPlanStore.js → saveAnimalPlan / loadLatestAnimalPlan
//
// UI MODES
// - herds: by species/breed
// - list: flat list
// - butchery: show upcoming culls and link to yieldCurves
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatAnimalPlanForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

import { getRecentImports } from "../../services/imports/ImportIntelligenceService";
import { suggestAnimalsFromIntelligence } from "../../services/animals/AnimalSuggestionService";
import {
  saveAnimalPlan,
  loadLatestAnimalPlan,
} from "../../services/animals/AnimalPlanStore";

const SOURCE_ID = "domain.animals.AnimalPlanner";

function AnimalPlanner() {
  // animals: [{ id, species, breed, qty, pen, care, butcherAt, sourceId, tags, domain }]
  const [animals, setAnimals] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [viewMode, setViewMode] = useState("herds"); // 'herds' | 'list' | 'butchery'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    async function init() {
      setLoading(true);
      try {
        const [latestPlan, recentImports] = await Promise.all([
          safeLoadLatestAnimalPlan(),
          safeGetRecentImports(),
        ]);

        if (!alive) return;

        if (latestPlan && Array.isArray(latestPlan.items)) {
          setAnimals(latestPlan.items);
          if (Array.isArray(latestPlan.favorites)) {
            setFavorites(latestPlan.favorites);
          }
        }

        const suggested = safeSuggestAnimalsFromIntelligence(recentImports, {
          includeButchery: true,
          includeDairy: true,
          includePoultry: true,
          includeRuminants: true,
        });
        setSuggestions(suggested || []);
      } catch (e) {
        console.warn("[AnimalPlanner] init failed", e);
        if (alive) setError("Unable to load animal planner data right now.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    init();

    // listen to new imports (animal/butchery)
    const offImport = eventBus?.on?.("import.parsed", handleImportParsed);
    // listen to garden/forage → might create new animal-feed tasks
    const offGarden = eventBus?.on?.(
      "garden.harvest.logged",
      handleGardenHarvest
    );
    // listen to storehouse.low → suggest "butcher surplus" or "reduce feed"
    const offStorehouseLow = eventBus?.on?.(
      "storehouse.low",
      handleStorehouseLow
    );

    return () => {
      alive = false;
      offImport && offImport();
      offGarden && offGarden();
      offStorehouseLow && offStorehouseLow();
    };
  }, []);

  // group by species/pen
  const herdsBySpecies = useMemo(() => {
    const map = {};
    (animals || []).forEach((a) => {
      const key = a.species || "Unassigned";
      if (!map[key]) map[key] = [];
      map[key].push(a);
    });
    return map;
  }, [animals]);

  const butcheryList = useMemo(() => {
    return [...(animals || [])]
      .filter((a) => !!a.butcherAt)
      .sort((a, b) => (a.butcherAt || "").localeCompare(b.butcherAt || ""));
  }, [animals]);

  // ---------------------------------------------------------------------------
  // BUS EVENT HANDLERS
  // ---------------------------------------------------------------------------

  function handleImportParsed(payload) {
    const domain = payload?.data?.domain;
    const normalized = payload?.data?.normalized;
    if (!normalized) return;

    if (
      domain === "animal" ||
      domain === "butchery" ||
      domain === "livestock" ||
      domain === "video"
    ) {
      const newSugs = safeSuggestAnimalsFromIntelligence([normalized], {
        includeButchery: true,
        includeDairy: true,
        includePoultry: true,
        includeRuminants: true,
      });
      if (newSugs && newSugs.length) {
        setSuggestions((prev) => [...newSugs, ...prev]);
      }
    }
  }

  function handleGardenHarvest(payload) {
    // If garden harvested fodder/forage → suggest animal-feed tasks
    try {
      const auto = autoGenerateAnimalFromGarden(payload?.data);
      if (auto?.length) {
        setSuggestions((prev) => [...auto, ...prev]);
      }
    } catch (e) {
      console.warn("[AnimalPlanner] garden.harvest.logged handler failed", e);
    }
  }

  function handleStorehouseLow(payload) {
    // If storehouse says "feed low" → suggest butchery or cull
    try {
      const auto = autoGenerateAnimalFromStorehouseLow(payload?.data);
      if (auto?.length) {
        setSuggestions((prev) => [...auto, ...prev]);
      }
    } catch (e) {
      console.warn("[AnimalPlanner] storehouse.low handler failed", e);
    }
  }

  // ---------------------------------------------------------------------------
  // UI HANDLERS
  // ---------------------------------------------------------------------------

  function handleAddFromSuggestion(s, targetPen = "Unassigned") {
    if (!s) return;
    const newItem = {
      id: s.id || makeId("animal"),
      species: s.species || s.title || "Animal",
      breed: s.breed || "",
      qty: s.qty || 1,
      pen: s.pen || targetPen,
      care: s.care || buildDefaultCare(s.species),
      butcherAt: s.butcherAt || buildDefaultButcheryDate(),
      sourceId: s.sourceId || s.url || null,
      tags: s.tags || [],
      domain: s.domain || "animal",
    };
    const next = [...animals, newItem];
    setAnimals(next);
    emitEvent("animal.plan.updated", {
      items: next,
      reason: "add-from-suggestion",
    });
  }

  function handlePenChange(itemId, newPen) {
    const next = animals.map((a) =>
      a.id === itemId
        ? {
            ...a,
            pen: newPen,
          }
        : a
    );
    setAnimals(next);
    emitEvent("animal.plan.updated", {
      items: next,
      reason: "pen-change",
    });
  }

  function handleButcherDateChange(itemId, newDate) {
    const next = animals.map((a) =>
      a.id === itemId
        ? {
            ...a,
            butcherAt: newDate,
          }
        : a
    );
    setAnimals(next);
    emitEvent("animal.plan.updated", {
      items: next,
      reason: "butcher-date-change",
    });
  }

  async function handleSavePlan(label = "") {
    const planToSave = {
      id: makeId("animalPlan"),
      label: label || `Animal Plan ${new Date().toLocaleString()}`,
      items: animals,
      favorites,
      ts: new Date().toISOString(),
    };
    try {
      await saveAnimalPlan(planToSave);
    } catch (e) {
      console.warn("[AnimalPlanner] failed to persist animal plan", e);
    }
    setFavorites((prev) => [planToSave, ...prev]);
    const evt = emitEvent("animal.plan.saved", {
      plan: planToSave,
    });
    await exportToHubIfEnabled(evt);
  }

  function handleApplyFavorite(plan) {
    if (!plan || !Array.isArray(plan.items)) return;
    setAnimals(plan.items);
    emitEvent("animal.plan.updated", {
      items: plan.items,
      reason: "apply-favorite",
    });
  }

  async function handleLogAcquisition(item) {
    // user says: "I actually acquired these 4 pullets today"
    const evt = emitEvent("animal.acquired", {
      item,
      ts: new Date().toISOString(),
    });
    // OPTIONAL: if acquiring animals consumes inventory (starter feed), we can also emit
    // an inventory.updated here. We'll do a small, safe decrement.
    const invEvt = emitEvent("inventory.updated", {
      source: "animal.acquired",
      deltas: [
        {
          item: "starter feed (general)",
          qty: 1,
          unit: "bag",
          direction: "decrement",
        },
      ],
    });
    await exportToHubIfEnabled(evt);
    await exportToHubIfEnabled(invEvt);
  }

  async function handleSendButcherRequest(item) {
    // user wants to send to AnimalSessionEngine → butchery
    const evt = emitEvent("animal.butcher.request", {
      item,
      butcherAt: item.butcherAt,
    });
    await exportToHubIfEnabled(evt);
  }

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  function renderToolbar() {
    return (
      <div className="ssa-animal-toolbar flex gap-3 mb-4 items-center">
        <h2 className="text-xl font-semibold">Animal Planner</h2>
        <div className="flex gap-2">
          <button
            className={viewMode === "herds" ? "btn-primary" : "btn-secondary"}
            onClick={() => setViewMode("herds")}
          >
            Herds/Pens
          </button>
          <button
            className={viewMode === "list" ? "btn-primary" : "btn-secondary"}
            onClick={() => setViewMode("list")}
          >
            List
          </button>
          <button
            className={
              viewMode === "butchery" ? "btn-primary" : "btn-secondary"
            }
            onClick={() => setViewMode("butchery")}
          >
            Butchery
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
                domain: "animal",
                items: animals,
                policy: "pens-first",
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
      <div className="ssa-animal-suggestions mb-4">
        <h3 className="font-semibold mb-2">
          Suggestions (imports, garden-forage, storehouse)
        </h3>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <div
              key={s.id || s.title || s.species}
              className="card p-2 rounded border bg-white"
            >
              <div className="font-medium">{s.species || s.title}</div>
              {s.tags && s.tags.length ? (
                <div className="text-xs text-gray-500 mb-1">
                  {s.tags.join(" • ")}
                </div>
              ) : null}
              <button
                className="btn-xs btn-primary"
                onClick={() =>
                  handleAddFromSuggestion(s, s.pen || "Unassigned")
                }
              >
                Add
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
      <div className="ssa-animal-favorites mb-4">
        <h3 className="font-semibold mb-2">Favorite Animal Plans</h3>
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

  function renderHerdsView() {
    const defaultPens = [
      "Chicken Coop",
      "Turkey / Waterfowl",
      "Sheep / Goats",
      "Cattle",
      "Rabbits",
      "Butchery / Quarantine",
      "Unassigned",
    ];
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {defaultPens.map((pen) => (
          <div key={pen} className="border rounded p-2 bg-white/50">
            <div className="font-semibold mb-2">{pen}</div>
            <div className="flex flex-col gap-1">
              {(animals || [])
                .filter((a) => (a.pen || "Unassigned") === pen)
                .map((a) => (
                  <div
                    key={a.id}
                    className="border rounded p-1 flex items-center justify-between bg-white"
                  >
                    <div>
                      <div className="text-sm font-medium">
                        {a.species}
                        {a.breed ? " – " + a.breed : ""}
                      </div>
                      <div className="text-xs text-gray-500">
                        Qty: {a.qty || 1}
                      </div>
                      <div className="text-xs text-gray-400">
                        Butcher:{" "}
                        <input
                          type="date"
                          className="text-xs border rounded"
                          value={a.butcherAt?.slice(0, 10) || ""}
                          onChange={(e) =>
                            handleButcherDateChange(a.id, e.target.value)
                          }
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 items-end">
                      <select
                        className="text-xs border rounded"
                        value={a.pen || "Unassigned"}
                        onChange={(e) => handlePenChange(a.id, e.target.value)}
                      >
                        {defaultPens.map((dp) => (
                          <option key={dp} value={dp}>
                            {dp}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn-xs"
                        onClick={() => handleLogAcquisition(a)}
                      >
                        Log acquired
                      </button>
                      <button
                        className="btn-xs"
                        onClick={() => handleSendButcherRequest(a)}
                      >
                        Send to butcher
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderListView() {
    if (!animals.length) {
      return <p className="text-sm text-gray-500">No animals planned yet.</p>;
    }
    return (
      <div className="flex flex-col gap-2">
        {animals.map((a) => (
          <div
            key={a.id}
            className="border rounded p-2 flex items-center justify-between"
          >
            <div>
              <div className="font-medium">
                {a.species}
                {a.breed ? " – " + a.breed : ""}
              </div>
              <div className="text-xs text-gray-500">
                Qty: {a.qty || 1} • Pen: {a.pen || "Unassigned"} • Butcher{" "}
                {a.butcherAt ? a.butcherAt.slice(0, 10) : "TBD"}
              </div>
            </div>
            <div className="flex gap-2 items-center">
              <select
                className="text-xs border rounded"
                value={a.pen || "Unassigned"}
                onChange={(e) => handlePenChange(a.id, e.target.value)}
              >
                {[
                  "Chicken Coop",
                  "Turkey / Waterfowl",
                  "Sheep / Goats",
                  "Cattle",
                  "Rabbits",
                  "Butchery / Quarantine",
                  "Unassigned",
                ].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                type="date"
                className="text-xs border rounded"
                value={a.butcherAt?.slice(0, 10) || ""}
                onChange={(e) => handleButcherDateChange(a.id, e.target.value)}
              />
              <button
                className="btn-xs"
                onClick={() => handleLogAcquisition(a)}
              >
                Acquired
              </button>
              <button
                className="btn-xs"
                onClick={() => handleSendButcherRequest(a)}
              >
                Butcher
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderButcheryView() {
    return (
      <div className="border rounded p-3 bg-white/50">
        <h3 className="font-semibold mb-2">Butchery schedule</h3>
        <p className="text-xs text-gray-600 mb-2">
          This shows animals with butchery dates. AnimalSessionEngine will pick
          these up and create butchery sessions that can use your yield curves
          (beef_brangus.json, sheep_katahdin.json, duck_muscovy.json, etc.) and
          update inventory/storehouse.
        </p>
        {butcheryList.length ? (
          <div className="flex flex-col gap-2">
            {butcheryList.map((a) => (
              <div
                key={a.id}
                className="border rounded p-2 bg-white flex items-center justify-between"
              >
                <div>
                  <div className="font-medium">
                    {a.species}
                    {a.breed ? " – " + a.breed : ""}
                  </div>
                  <div className="text-xs text-gray-500">
                    Butcher: {a.butcherAt.slice(0, 10)}
                  </div>
                </div>
                <button
                  className="btn-xs"
                  onClick={() => handleSendButcherRequest(a)}
                >
                  Send to butcher
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            No animals scheduled for butchery.
          </p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">Loading animal planner…</p>
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {renderToolbar()}
      {error ? <p className="text-red-500 text-sm">{error}</p> : null}
      {renderSuggestions()}
      {renderFavorites()}
      {viewMode === "herds" ? renderHerdsView() : null}
      {viewMode === "list" ? renderListView() : null}
      {viewMode === "butchery" ? renderButcheryView() : null}
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
    console.warn("[AnimalPlanner] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;

    const packet = formatAnimalPlanForHub(evtPayload);
    if (!packet) return;

    await FamilyFundConnector.send(packet);
  } catch (e) {
    console.warn("[AnimalPlanner] Hub export failed (silent)", e);
  }
}

async function safeLoadLatestAnimalPlan() {
  try {
    const plan = await loadLatestAnimalPlan();
    return plan;
  } catch (e) {
    console.warn("[AnimalPlanner] safeLoadLatestAnimalPlan failed", e);
    return null;
  }
}

async function safeGetRecentImports() {
  try {
    const imports = await getRecentImports({
      domains: ["animal", "butchery", "livestock", "video", "forage"],
      limit: 40,
    });
    return imports;
  } catch (e) {
    console.warn("[AnimalPlanner] safeGetRecentImports failed", e);
    return [];
  }
}

function safeSuggestAnimalsFromIntelligence(intel, opts) {
  try {
    const res = suggestAnimalsFromIntelligence(intel, opts);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    console.warn(
      "[AnimalPlanner] safeSuggestAnimalsFromIntelligence failed",
      e
    );
    return [];
  }
}

function autoGenerateAnimalFromGarden(data) {
  if (!data) return [];
  // If you harvested forage / fodder → suggest "Feed goats/sheep" task
  return [
    {
      id: makeId("auto"),
      species: "Goats / Sheep",
      qty: 0, // it is a care task not new animals
      pen: "Sheep / Goats",
      care: [{ type: "feed-forage", every: "1d" }],
      tags: ["auto", "from-garden"],
      domain: "animal",
    },
  ];
}

function autoGenerateAnimalFromStorehouseLow(data) {
  if (!data) return [];
  // If storehouse feed is low → suggest culling/butchery
  return [
    {
      id: makeId("auto"),
      species: "Culling (older birds)",
      qty: 0,
      pen: "Butchery / Quarantine",
      butcherAt: new Date().toISOString(),
      tags: ["auto", "storehouse-low"],
      domain: "animal",
    },
  ];
}

function buildDefaultCare(species = "") {
  const lower = species.toLowerCase();
  const base = [
    { type: "feed", every: "1d" },
    { type: "water", every: "1d" },
  ];
  if (
    lower.includes("chicken") ||
    lower.includes("turkey") ||
    lower.includes("duck")
  ) {
    base.push({ type: "clean-coop", every: "7d" });
  }
  if (lower.includes("goat") || lower.includes("sheep")) {
    base.push({ type: "rotate-pasture", every: "7d" });
  }
  if (lower.includes("cow") || lower.includes("cattle")) {
    base.push({ type: "clean-stall", every: "7d" });
  }
  return base;
}

function buildDefaultButcheryDate() {
  // default to +30 days — user will adjust
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString();
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default AnimalPlanner;
