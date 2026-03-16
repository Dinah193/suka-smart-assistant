// C:\Users\larho\suka-smart-assistant\src\domain\storehouse\StorehousePlanner.jsx
// Long-term stock goal planner
// -----------------------------------------------------------------------------
// ROLE IN SSA PIPELINE
// imports (storehouse plans, pantry-staples lists, preservation batches, animal/butchery yields,
// garden harvest logs, video/how-to about root cellars & long storage)
//   → ImportService → normalized payload → domain: "storehouse"
//   → StorehousePlanner (THIS FILE) turns that into household *goals* like:
//       - 6 months of beans, 2 varieties
//       - 12 gallons of pressure-canned broth
//       - 25 lb of rendered fat (from butchery sessions)
//       - 10 cases cleaning supplies
//   → emits to shared event bus:
//       - storehouse.goal.updated
//       - storehouse.goal.saved
//       - storehouse.low
//       - storehouse.push.request (for inventory to pull from storehouse)
//   → automation runtime can schedule: preservation, batch cooking, animal butchery, garden harvest
//   → (optional) if featureFlags.familyFundMode === true → exportToHubIfEnabled(...)
//
//
// WHY WE NEED THIS
// - You said: SSA and SVFFH are separate; SSA must run alone BUT SSA info must be optionally
//   sent to the Hub so businesses can know what to produce.
// - That means SSA has to maintain *complete* household stock goals, not just "opt-in" items.
// - This planner is where you define the STOREHOUSE view of the home (deeper than inventory).
//
// ASSUMPTIONS / SOFT IMPORTS
// - src/services/events/eventBus.js
// - src/config/featureFlags.json
// - src/services/hub/HubPacketFormatter.js → formatStorehousePlanForHub
// - src/services/hub/FamilyFundConnector.js
// - src/services/storehouse/StorehousePlanStore.js → loadLatest / save
// - src/services/inventory/InventorySessionEngine.js → can be asked to generate restock sessions
//
// UI GOALS
// - see goals by "aisle"/"room": Dry Storage, Cold Storage, Root Cellar, Cleaning, Animal Feed
// - add item with desired qty + unit + time horizon
// - show progress if inventory already has some
// - emit "storehouse.low" when current < min
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatStorehousePlanForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

let StorehousePlanStore = null;
let InventorySessionEngine = null;

try {
  // eslint-disable-next-line global-require
  StorehousePlanStore = require("../../services/storehouse/StorehousePlanStore.js");
} catch (e) {
  StorehousePlanStore = null;
}

try {
  // eslint-disable-next-line global-require
  InventorySessionEngine = require("../inventory/InventorySessionEngine.js")
    .default
    ? require("../inventory/InventorySessionEngine.js").default
    : require("../inventory/InventorySessionEngine.js");
} catch (e) {
  InventorySessionEngine = null;
}

const SOURCE_ID = "domain.storehouse.StorehousePlanner";

const DEFAULT_ZONES = [
  "Dry Storage",
  "Cold Storage",
  "Root Cellar",
  "Freezer Overflow",
  "Cleaning & Paper",
  "Animal Feed",
  "Preserved Goods",
  "Emergency / Sabbath",
];

function StorehousePlanner() {
  const [goals, setGoals] = useState([]); // [{id, name, zone, targetQty, unit, currentQty, minQty, horizon, category}]
  const [favorites, setFavorites] = useState([]);
  const [activeZone, setActiveZone] = useState("Dry Storage");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // quick-add controls
  const [qaName, setQaName] = useState("");
  const [qaTargetQty, setQaTargetQty] = useState("12");
  const [qaUnit, setQaUnit] = useState("ea");
  const [qaZone, setQaZone] = useState("Dry Storage");
  const [qaHorizon, setQaHorizon] = useState("6mo");

  useEffect(() => {
    let alive = true;

    async function init() {
      setLoading(true);
      try {
        const latest = await safeLoadLatestStorehousePlan();
        if (!alive) return;
        if (latest && Array.isArray(latest.items)) {
          setGoals(latest.items);
        }
        if (latest && Array.isArray(latest.favorites)) {
          setFavorites(latest.favorites);
        }
      } catch (e) {
        console.warn("[StorehousePlanner] init failed", e);
        if (alive) setError("Unable to load storehouse plan.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    init();

    // inventory.updated → update currentQty for goals that match
    const offInv = eventBus?.on?.("inventory.updated", handleInventoryUpdated);
    // garden.harvest.logged → may feed storehouse
    const offGarden = eventBus?.on?.(
      "garden.harvest.logged",
      handleGardenHarvest
    );
    // preservation.completed → may feed storehouse
    const offPres = eventBus?.on?.(
      "preservation.completed",
      handlePreservationCompleted
    );
    // animal.executed → may feed storehouse (fat, bones, hides)
    const offAnimal = eventBus?.on?.("animal.executed", handleAnimalExecuted);

    return () => {
      offInv && offInv();
      offGarden && offGarden();
      offPres && offPres();
      offAnimal && offAnimal();
      alive = false;
    };
  }, []);

  const zones = useMemo(() => {
    const set = new Set(DEFAULT_ZONES);
    (goals || []).forEach((g) => set.add(g.zone || "Unassigned"));
    return Array.from(set);
  }, [goals]);

  const filteredGoals = useMemo(() => {
    return (goals || []).filter((g) => {
      if (activeZone !== "all" && (g.zone || "Unassigned") !== activeZone)
        return false;
      if (
        search &&
        !(g.name || "").toLowerCase().includes(search.toLowerCase())
      )
        return false;
      return true;
    });
  }, [goals, activeZone, search]);

  const lowGoals = useMemo(() => {
    return (goals || []).filter((g) => {
      const curr = Number(g.currentQty) || 0;
      const min = Number(g.minQty) || 0;
      return min > 0 && curr < min;
    });
  }, [goals]);

  // ---------------------------------------------------------------------------
  // EVENT HANDLERS
  // ---------------------------------------------------------------------------

  function handleInventoryUpdated(payload) {
    const deltas = payload?.data?.deltas;
    if (!Array.isArray(deltas) || !deltas.length) return;
    // for each delta, if we have a goal with same name → update currentQty
    setGoals((prev) => {
      const next = prev.map((g) => {
        const matched = deltas.find(
          (d) => normalizeName(d.item) === normalizeName(g.name)
        );
        if (!matched) return g;
        const direction = matched.direction === "decrement" ? -1 : 1;
        const qty = Number(matched.qty) || 0;
        const newCurr = (Number(g.currentQty) || 0) + direction * qty;
        return {
          ...g,
          currentQty: newCurr < 0 ? 0 : newCurr,
        };
      });
      // also: if after update, some are below min → emit storehouse.low
      const lows = next.filter(
        (g) => (Number(g.currentQty) || 0) < (Number(g.minQty) || 0)
      );
      if (lows.length) {
        const evt = emitEvent("storehouse.low", {
          items: lows.map((lg) => ({
            name: lg.name,
            zone: lg.zone,
            current: lg.currentQty,
            min: lg.minQty,
            target: lg.targetQty,
          })),
        });
        exportToHubIfEnabled(evt);
      }
      return next;
    });
  }

  function handleGardenHarvest(payload) {
    const items = payload?.data?.items;
    if (!Array.isArray(items) || !items.length) return;
    // If we harvested something that is also a storehouse goal (like "carrots" for root cellar)
    // we should bump currentQty for that goal.
    setGoals((prev) =>
      prev.map((g) => {
        const match = items.find(
          (it) => normalizeName(it.crop) === normalizeName(g.name)
        );
        if (!match) return g;
        const inc = Number(match.qty) || 0;
        return {
          ...g,
          currentQty: (Number(g.currentQty) || 0) + inc,
        };
      })
    );
  }

  function handlePreservationCompleted(payload) {
    const items = payload?.data?.items;
    if (!Array.isArray(items) || !items.length) return;
    setGoals((prev) =>
      prev.map((g) => {
        const match = items.find(
          (it) => normalizeName(it.name) === normalizeName(g.name)
        );
        if (!match) return g;
        const inc = Number(match.qty) || 0;
        return {
          ...g,
          currentQty: (Number(g.currentQty) || 0) + inc,
        };
      })
    );
  }

  function handleAnimalExecuted(payload) {
    const byproducts = payload?.data?.actuals?.byproducts;
    if (!Array.isArray(byproducts) || !byproducts.length) return;
    setGoals((prev) =>
      prev.map((g) => {
        const match = byproducts.find(
          (bp) => normalizeName(bp.name) === normalizeName(g.name)
        );
        if (!match) return g;
        const inc = Number(match.qty) || 0;
        return {
          ...g,
          currentQty: (Number(g.currentQty) || 0) + inc,
        };
      })
    );
  }

  // ---------------------------------------------------------------------------
  // UI HANDLERS
  // ---------------------------------------------------------------------------

  async function handleQuickAdd(e) {
    e.preventDefault();
    const name = qaName.trim();
    if (!name) return;
    const newGoal = {
      id: makeId("storeGoal"),
      name,
      zone: qaZone || "Dry Storage",
      targetQty: Number(qaTargetQty) || 1,
      unit: qaUnit || "ea",
      currentQty: 0,
      minQty: Math.ceil((Number(qaTargetQty) || 1) * 0.25), // 25% of target as min
      horizon: qaHorizon || "6mo",
      category: guessCategoryFromName(name),
      source: "manual",
      createdAt: new Date().toISOString(),
    };

    const next = [...goals, newGoal];
    setGoals(next);

    const evt = emitEvent("storehouse.goal.updated", {
      items: next,
      reason: "quick-add",
      added: newGoal,
    });
    await exportToHubIfEnabled(evt);

    // reset
    setQaName("");
    setQaTargetQty("12");
  }

  async function handleSavePlan(label = "") {
    const plan = {
      id: makeId("storePlan"),
      label: label || `Storehouse plan — ${new Date().toLocaleString()}`,
      items: goals,
      favorites,
      ts: new Date().toISOString(),
    };

    try {
      await saveStorehousePlan(plan);
    } catch (e) {
      console.warn("[StorehousePlanner] failed to save storehouse plan", e);
    }

    setFavorites((prev) => [plan, ...prev]);
    const evt = emitEvent("storehouse.goal.saved", {
      plan,
    });
    await exportToHubIfEnabled(evt);
  }

  function handleApplyFavorite(plan) {
    if (!plan || !Array.isArray(plan.items)) return;
    setGoals(plan.items);
    emitEvent("storehouse.goal.updated", {
      items: plan.items,
      reason: "apply-favorite",
    });
  }

  async function handleAdjustCurrent(goalId, delta) {
    const next = goals.map((g) =>
      g.id === goalId
        ? {
            ...g,
            currentQty: Math.max((Number(g.currentQty) || 0) + delta, 0),
          }
        : g
    );
    setGoals(next);

    const changed = next.find((g) => g.id === goalId);
    const evt = emitEvent("storehouse.goal.updated", {
      items: next,
      changed,
    });
    await exportToHubIfEnabled(evt);

    // If it went below min, emit storehouse.low
    if ((Number(changed.currentQty) || 0) < (Number(changed.minQty) || 0)) {
      const lowEvt = emitEvent("storehouse.low", {
        items: [
          {
            name: changed.name,
            zone: changed.zone,
            current: changed.currentQty,
            min: changed.minQty,
            target: changed.targetQty,
          },
        ],
      });
      await exportToHubIfEnabled(lowEvt);
    }
  }

  async function handleGenerateRestock() {
    // Use InventorySessionEngine (if present) to create a restock session from current LOW goals
    if (!lowGoals.length) return;
    if (
      !InventorySessionEngine ||
      typeof InventorySessionEngine.generateRestockSession !== "function"
    ) {
      console.warn("[StorehousePlanner] InventorySessionEngine not available");
      return;
    }
    const session = await InventorySessionEngine.generateRestockSession(
      lowGoals.map((g) => ({
        name: g.name,
        qty: g.currentQty,
        min: g.minQty,
        unit: g.unit,
        location: "Storehouse",
      })),
      { target: "storehouse" }
    );
    // session is emitted from the engine already
    return session;
  }

  function renderToolbar() {
    return (
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <h2 className="text-xl font-semibold">Storehouse Planner</h2>
        <input
          type="text"
          className="border rounded px-2 py-1 text-sm"
          placeholder="Search goal…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="border rounded px-2 py-1 text-sm"
          value={activeZone}
          onChange={(e) => setActiveZone(e.target.value)}
        >
          <option value="all">All zones</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <div className="flex gap-2 ml-auto">
          <button className="btn-secondary" onClick={() => handleSavePlan("")}>
            Save as favorite
          </button>
          <button className="btn-secondary" onClick={handleGenerateRestock}>
            Generate restock
          </button>
          <button
            className="btn-secondary"
            onClick={() =>
              emitEvent("automation.schedule.request", {
                domain: "storehouse",
                items: goals,
                policy: "zone-first",
              })
            }
          >
            Send to automation
          </button>
        </div>
      </div>
    );
  }

  function renderQuickAdd() {
    return (
      <form
        className="flex flex-wrap gap-2 mb-4 items-center"
        onSubmit={handleQuickAdd}
      >
        <input
          type="text"
          className="border rounded px-2 py-1 text-sm"
          placeholder="Item name (beans, flour, soap…)"
          value={qaName}
          onChange={(e) => setQaName(e.target.value)}
        />
        <input
          type="number"
          className="border rounded px-2 py-1 text-sm w-20"
          value={qaTargetQty}
          min="1"
          onChange={(e) => setQaTargetQty(e.target.value)}
        />
        <input
          type="text"
          className="border rounded px-2 py-1 text-sm w-20"
          value={qaUnit}
          onChange={(e) => setQaUnit(e.target.value)}
        />
        <select
          className="border rounded px-2 py-1 text-sm"
          value={qaZone}
          onChange={(e) => setQaZone(e.target.value)}
        >
          {DEFAULT_ZONES.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
          <option value="Unassigned">Unassigned</option>
        </select>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={qaHorizon}
          onChange={(e) => setQaHorizon(e.target.value)}
        >
          <option value="3mo">3 months</option>
          <option value="6mo">6 months</option>
          <option value="12mo">12 months</option>
          <option value="24mo">24+ months</option>
        </select>
        <button className="btn-primary" type="submit">
          Add goal
        </button>
      </form>
    );
  }

  function renderFavorites() {
    if (!favorites.length) return null;
    return (
      <div className="mb-4">
        <h3 className="font-semibold mb-2">Favorite storehouse plans</h3>
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

  function renderLowGoals() {
    if (!lowGoals.length) return null;
    return (
      <div className="border rounded p-3 bg-amber-50 mb-4">
        <h3 className="font-semibold mb-2">Low storehouse sections</h3>
        <p className="text-xs text-gray-600 mb-2">
          SSA will emit <code>storehouse.low</code> so inventory, meal, garden,
          animal, and preservation modules can react.
        </p>
        <div className="flex flex-wrap gap-2">
          {lowGoals.map((g) => (
            <div key={g.id} className="border rounded p-2 bg-white">
              <div className="font-medium">{g.name}</div>
              <div className="text-xs text-gray-500">
                {g.currentQty}/{g.minQty}/{g.targetQty} {g.unit} • {g.zone}
              </div>
              <button
                className="btn-xs"
                onClick={() =>
                  emitEvent("grocerylist.add.request", {
                    items: [
                      {
                        name: g.name,
                        qty:
                          (Number(g.minQty) || 1) - (Number(g.currentQty) || 0),
                        unit: g.unit,
                      },
                    ],
                  })
                }
              >
                Add to grocery
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderGoalsGrid() {
    if (!filteredGoals.length) {
      return (
        <p className="text-xs text-gray-500">
          No storehouse goals match your filters.
        </p>
      );
    }
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredGoals.map((g) => (
          <div
            key={g.id}
            className="border rounded p-2 bg-white flex justify-between gap-2"
          >
            <div>
              <div className="font-medium">{g.name}</div>
              <div className="text-xs text-gray-500">
                {g.currentQty}/{g.targetQty} {g.unit} • {g.zone}
              </div>
              <div className="text-xs text-gray-400">
                Min {g.minQty} • {g.horizon}
              </div>
              <ProgressBar current={g.currentQty} target={g.targetQty} />
            </div>
            <div className="flex flex-col gap-1 items-end">
              <button
                className="btn-xs"
                onClick={() => handleAdjustCurrent(g.id, +1)}
              >
                +1
              </button>
              <button
                className="btn-xs"
                onClick={() => handleAdjustCurrent(g.id, -1)}
              >
                -1
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">Loading storehouse plan…</p>
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {renderToolbar()}
      {error ? <p className="text-red-500 text-sm">{error}</p> : null}
      {renderQuickAdd()}
      {renderFavorites()}
      {renderLowGoals()}
      {renderGoalsGrid()}
    </div>
  );
}

// -----------------------------------------------------------------------------
// SUB COMPONENTS
// -----------------------------------------------------------------------------

function ProgressBar({ current = 0, target = 1 }) {
  const pct = Math.min(
    100,
    Math.round(((Number(current) || 0) / (Number(target) || 1)) * 100)
  );
  return (
    <div className="w-full bg-gray-200 rounded h-2 mt-1">
      <div
        className="bg-emerald-500 h-2 rounded"
        style={{ width: pct + "%" }}
      ></div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

async function safeLoadLatestStorehousePlan() {
  if (
    StorehousePlanStore &&
    typeof StorehousePlanStore.loadLatest === "function"
  ) {
    try {
      const plan = await StorehousePlanStore.loadLatest();
      return plan;
    } catch (e) {
      console.warn(
        "[StorehousePlanner] safeLoadLatestStorehousePlan failed",
        e
      );
      return null;
    }
  }
  return null;
}

async function saveStorehousePlan(plan) {
  if (StorehousePlanStore && typeof StorehousePlanStore.save === "function") {
    try {
      await StorehousePlanStore.save(plan);
      return;
    } catch (e) {
      console.warn("[StorehousePlanner] saveStorehousePlan failed", e);
    }
  }
}

function normalizeName(name) {
  return (name || "").toLowerCase().trim();
}

function guessCategoryFromName(name) {
  const low = (name || "").toLowerCase();
  if (low.includes("flour") || low.includes("rice") || low.includes("beans"))
    return "dry-goods";
  if (
    low.includes("soap") ||
    low.includes("bleach") ||
    low.includes("detergent")
  )
    return "cleaning";
  if (low.includes("feed")) return "animal-feed";
  return "general";
}

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
    console.warn("[StorehousePlanner] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatStorehousePlanForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    console.warn("[StorehousePlanner] Hub export failed (silent)", e);
  }
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default StorehousePlanner;
