// C:\Users\larho\suka-smart-assistant\src\domain\inventory\InventoryDashboard.jsx
// Household inventory interface
// -----------------------------------------------------------------------------
// ROLE IN SSA PIPELINE
// imports (recipes, cleaning routines, garden harvests, animal/butchery yields, storehouse plans)
//   → ImportService → normalized payloads
//   → InventoryDashboard (THIS FILE) shows you:
//       - what is in inventory right now (by category / location)
//       - what is low / expiring
//       - what came from garden / animals / preservation
//       - what needs to be pushed up to storehouse
//   → user can adjust → emits inventory.updated
//   → emits inventory.shortage.detected → Meals / Garden / Animal planners can react
//   → if familyFundMode=true → also export to Hub
//
// OTHER MODULES HOOKING INTO THIS:
// - GardenSessionEngine → emits garden.harvest.logged → we show it as incoming
// - AnimalSessionEngine → emits inventory.updated (meat, bones, fat)
// - CleaningSessionEngine → emits inventory.updated (supplies decrement)
// - Storehouse planner → emits storehouse.low → we can flag items here
//
// ALL EVENTS ARE SHAPE:
//   { type, ts, source, data }
//
// ASSUMPTIONS (all defensive):
// - src/services/events/eventBus.js
// - src/config/featureFlags.json
// - src/services/hub/HubPacketFormatter.js → formatInventoryUpdateForHub
// - src/services/hub/FamilyFundConnector.js
// - src/services/inventory/InventoryService.js → getAll, upsert, adjust, bulkAdjust
// - src/services/inventory/InventoryStore.js → optional Dexie-backed store
//
// UI GOALS
// - filters: category, location, source
// - quick-add item (manual entry, because user said imports must NOT be recipe-only)
// - show “incoming” (from garden/animal/preservation)
// - show “low / shortage” items
// - buttons to emit events for automations (e.g. “send low to grocery list”)
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatInventoryUpdateForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

let InventoryService = null;
let InventoryStore = null;

try {
  // eslint-disable-next-line global-require
  InventoryService = require("../../services/inventory/InventoryService.js");
} catch (e) {
  InventoryService = null;
}

try {
  // eslint-disable-next-line global-require
  InventoryStore = require("../../services/inventory/InventoryStore.js");
} catch (e) {
  InventoryStore = null;
}

const SOURCE_ID = "domain.inventory.InventoryDashboard";

function InventoryDashboard() {
  const [items, setItems] = useState([]);
  const [incoming, setIncoming] = useState([]); // from garden / animal / preservation
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterLocation, setFilterLocation] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // quick-add controls
  const [qaName, setQaName] = useState("");
  const [qaQty, setQaQty] = useState("1");
  const [qaUnit, setQaUnit] = useState("ea");
  const [qaLocation, setQaLocation] = useState("Pantry");
  const [qaCategory, setQaCategory] = useState("general");

  useEffect(() => {
    let alive = true;

    async function init() {
      setLoading(true);
      try {
        const base = await loadInventory();
        if (!alive) return;
        setItems(base || []);
      } catch (e) {
        console.warn("[InventoryDashboard] init failed", e);
        if (alive) setError("Unable to load inventory right now.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    init();

    // listen for events that affect inventory UI
    const offInvUpdate = eventBus?.on?.(
      "inventory.updated",
      handleInventoryUpdated
    );
    const offGarden = eventBus?.on?.(
      "garden.harvest.logged",
      handleGardenHarvestLogged
    );
    const offAnimal = eventBus?.on?.(
      "animal.session.executed",
      handleAnimalExecuted
    );
    const offPres = eventBus?.on?.(
      "preservation.completed",
      handlePreservationCompleted
    );
    const offStorehouse = eventBus?.on?.("storehouse.low", handleStorehouseLow);

    return () => {
      offInvUpdate && offInvUpdate();
      offGarden && offGarden();
      offAnimal && offAnimal();
      offPres && offPres();
      offStorehouse && offStorehouse();
      alive = false;
    };
  }, []);

  // computed
  const categories = useMemo(() => {
    const set = new Set();
    (items || []).forEach((it) => set.add(it.category || "general"));
    return ["all", ...Array.from(set)];
  }, [items]);

  const locations = useMemo(() => {
    const set = new Set();
    (items || []).forEach((it) => set.add(it.location || "Pantry"));
    return ["all", ...Array.from(set)];
  }, [items]);

  const filteredItems = useMemo(() => {
    return (items || []).filter((it) => {
      if (
        filterCategory !== "all" &&
        (it.category || "general") !== filterCategory
      )
        return false;
      if (
        filterLocation !== "all" &&
        (it.location || "Pantry") !== filterLocation
      )
        return false;
      if (
        search &&
        !(it.name || "").toLowerCase().includes(search.toLowerCase())
      )
        return false;
      return true;
    });
  }, [items, filterCategory, filterLocation, search]);

  const lowItems = useMemo(() => {
    return (items || []).filter((it) => {
      const qty = Number(it.qty) || 0;
      const min = Number(it.min) || 0;
      return qty <= min && min > 0;
    });
  }, [items]);

  // ---------------------------------------------------------------------------
  // EVENT HANDLERS
  // ---------------------------------------------------------------------------

  function handleInventoryUpdated(payload) {
    const deltas = payload?.data?.deltas;
    if (!Array.isArray(deltas) || !deltas.length) return;
    // refresh inventory from store/service
    refreshInventory();
  }

  function handleGardenHarvestLogged(payload) {
    const harvested = payload?.data?.items;
    if (!Array.isArray(harvested) || !harvested.length) return;
    // show in incoming, user can "accept"
    setIncoming((prev) => [
      ...harvested.map((h) => ({
        id: makeId("incoming"),
        name: h.crop,
        qty: h.qty,
        unit: h.unit || "ea",
        source: "garden",
        zone: h.zone || null,
      })),
      ...prev,
    ]);
  }

  function handleAnimalExecuted(payload) {
    const actuals = payload?.data?.actuals;
    if (!actuals) return;
    // if animal session produced byproducts or meat → show as incoming
    const incomingMeat = [];
    if (Array.isArray(actuals.animalsButchered)) {
      actuals.animalsButchered.forEach((ab) => {
        if (Array.isArray(ab.parts) && ab.parts.length) {
          ab.parts.forEach((p) =>
            incomingMeat.push({
              id: makeId("incoming"),
              name: p.name,
              qty: p.qty,
              unit: p.unit || "lb",
              source: "animal",
            })
          );
        } else {
          incomingMeat.push({
            id: makeId("incoming"),
            name: `meat (${ab.species || "animal"})`,
            qty: ab.estimatedMeat || 1,
            unit: "lb",
            source: "animal",
          });
        }
      });
    }
    if (incomingMeat.length) {
      setIncoming((prev) => [...incomingMeat, ...prev]);
    }
  }

  function handlePreservationCompleted(payload) {
    const preserved = payload?.data?.items;
    if (!Array.isArray(preserved) || !preserved.length) return;
    setIncoming((prev) => [
      ...preserved.map((p) => ({
        id: makeId("incoming"),
        name: p.name,
        qty: p.qty,
        unit: p.unit || "jar",
        source: "preservation",
      })),
      ...prev,
    ]);
  }

  function handleStorehouseLow(payload) {
    // show banner + highlight relevant inventory items
    // payload might contain { items: [{name, neededQty, unit}] }
    const items = payload?.data?.items || [];
    if (!items.length) return;
    // We won't mutate existing items directly; just refresh so InventoryService can reflect it
    refreshInventory();
  }

  // ---------------------------------------------------------------------------
  // UI HANDLERS
  // ---------------------------------------------------------------------------

  async function refreshInventory() {
    const base = await loadInventory();
    setItems(base || []);
  }

  async function handleQuickAdd(e) {
    e.preventDefault();
    const name = qaName.trim();
    if (!name) return;
    const newItem = {
      id: makeId("inv"),
      name,
      qty: Number(qaQty) || 1,
      unit: qaUnit || "ea",
      location: qaLocation || "Pantry",
      category: qaCategory || "general",
      source: "manual",
      min: 0,
    };
    await upsertInventoryItem(newItem);
    setQaName("");
    setQaQty("1");
    // Emit inventory.updated
    const evt = emitEvent("inventory.updated", {
      deltas: [
        {
          item: name,
          qty: newItem.qty,
          unit: newItem.unit,
          direction: "increment",
          location: newItem.location,
        },
      ],
    });
    await exportToHubIfEnabled(evt);
  }

  async function handleIncomingAccept(inc) {
    // move incoming → actual inventory
    const item = {
      id: makeId("inv"),
      name: inc.name,
      qty: inc.qty,
      unit: inc.unit,
      location: "Pantry",
      category: mapIncomingToCategory(inc),
      source: inc.source,
      min: 0,
    };
    await upsertInventoryItem(item);
    setIncoming((prev) => prev.filter((p) => p.id !== inc.id));

    const evt = emitEvent("inventory.updated", {
      deltas: [
        {
          item: item.name,
          qty: item.qty,
          unit: item.unit,
          direction: "increment",
          location: item.location,
          source: inc.source,
        },
      ],
    });
    await exportToHubIfEnabled(evt);
  }

  function handleIncomingReject(inc) {
    setIncoming((prev) => prev.filter((p) => p.id !== inc.id));
  }

  async function handleAdjustQty(itemId, delta) {
    const item = items.find((it) => it.id === itemId);
    if (!item) return;
    const newQty = (Number(item.qty) || 0) + delta;
    const updated = {
      ...item,
      qty: newQty < 0 ? 0 : newQty,
    };
    await upsertInventoryItem(updated);
    // local update
    setItems((prev) => prev.map((it) => (it.id === itemId ? updated : it)));

    const evt = emitEvent("inventory.updated", {
      deltas: [
        {
          item: item.name,
          qty: Math.abs(delta),
          unit: item.unit || "ea",
          direction: delta > 0 ? "increment" : "decrement",
          location: item.location,
        },
      ],
    });
    await exportToHubIfEnabled(evt);

    // if low after decrement → emit shortage
    if (updated.qty <= (Number(updated.min) || 0)) {
      const shortEvt = emitEvent("inventory.shortage.detected", {
        items: [
          {
            name: updated.name,
            qty: updated.qty,
            min: updated.min,
            location: updated.location,
          },
        ],
      });
      await exportToHubIfEnabled(shortEvt);
    }
  }

  function renderToolbar() {
    return (
      <div className="ssa-inventory-toolbar flex flex-wrap gap-3 mb-4 items-center">
        <h2 className="text-xl font-semibold">Household Inventory</h2>
        <input
          type="text"
          className="border rounded px-2 py-1 text-sm"
          placeholder="Search item…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="border rounded px-2 py-1 text-sm"
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === "all" ? "All categories" : c}
            </option>
          ))}
        </select>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={filterLocation}
          onChange={(e) => setFilterLocation(e.target.value)}
        >
          {locations.map((l) => (
            <option key={l} value={l}>
              {l === "all" ? "All locations" : l}
            </option>
          ))}
        </select>
        <div className="flex gap-2 ml-auto">
          <button
            className="btn-secondary"
            onClick={() =>
              emitEvent("automation.schedule.request", {
                domain: "inventory",
                items,
                policy: "low-first",
              })
            }
          >
            Send low to automation
          </button>
          <button
            className="btn-secondary"
            onClick={() =>
              emitEvent("storehouse.push.request", {
                domain: "inventory",
                items: lowItems,
              })
            }
          >
            Push to storehouse
          </button>
        </div>
      </div>
    );
  }

  function renderQuickAdd() {
    return (
      <form
        className="flex flex-wrap gap-2 items-center mb-4"
        onSubmit={handleQuickAdd}
      >
        <input
          type="text"
          className="border rounded px-2 py-1 text-sm"
          placeholder="Item name"
          value={qaName}
          onChange={(e) => setQaName(e.target.value)}
        />
        <input
          type="number"
          className="border rounded px-2 py-1 text-sm w-20"
          value={qaQty}
          min="0"
          onChange={(e) => setQaQty(e.target.value)}
        />
        <input
          type="text"
          className="border rounded px-2 py-1 text-sm w-20"
          value={qaUnit}
          onChange={(e) => setQaUnit(e.target.value)}
        />
        <select
          className="border rounded px-2 py-1 text-sm"
          value={qaLocation}
          onChange={(e) => setQaLocation(e.target.value)}
        >
          <option value="Pantry">Pantry</option>
          <option value="Freezer">Freezer</option>
          <option value="Fridge">Fridge</option>
          <option value="Root Cellar">Root Cellar</option>
          <option value="Storehouse">Storehouse</option>
        </select>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={qaCategory}
          onChange={(e) => setQaCategory(e.target.value)}
        >
          <option value="general">General</option>
          <option value="produce">Produce</option>
          <option value="meat">Meat</option>
          <option value="dry-goods">Dry goods</option>
          <option value="cleaning">Cleaning</option>
          <option value="animal-feed">Animal feed</option>
          <option value="preserved">Preserved</option>
        </select>
        <button className="btn-primary" type="submit">
          Add
        </button>
      </form>
    );
  }

  function renderIncoming() {
    if (!incoming.length) return null;
    return (
      <div className="border rounded p-3 bg-white/50 mb-4">
        <h3 className="font-semibold mb-2">
          Incoming (from garden / animal / preservation)
        </h3>
        <div className="flex gap-2 flex-wrap">
          {incoming.map((inc) => (
            <div
              key={inc.id}
              className="border rounded p-2 bg-white flex items-center gap-2"
            >
              <div>
                <div className="font-medium">{inc.name}</div>
                <div className="text-xs text-gray-500">
                  {inc.qty} {inc.unit} • {inc.source}
                </div>
              </div>
              <button
                className="btn-xs btn-primary"
                onClick={() => handleIncomingAccept(inc)}
              >
                Accept
              </button>
              <button
                className="btn-xs"
                onClick={() => handleIncomingReject(inc)}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderLowItems() {
    if (!lowItems.length) return null;
    return (
      <div className="border rounded p-3 bg-amber-50 mb-4">
        <h3 className="font-semibold mb-2">Low / needs attention</h3>
        <div className="flex flex-wrap gap-2">
          {lowItems.map((it) => (
            <div
              key={it.id}
              className="border rounded p-2 bg-white flex items-center gap-2"
            >
              <div>
                <div className="font-medium">{it.name}</div>
                <div className="text-xs text-gray-500">
                  {it.qty}/{it.min} {it.unit} • {it.location}
                </div>
              </div>
              <button
                className="btn-xs btn-primary"
                onClick={() =>
                  emitEvent("inventory.shortage.detected", {
                    items: [
                      {
                        name: it.name,
                        qty: it.qty,
                        min: it.min,
                        location: it.location,
                      },
                    ],
                  })
                }
              >
                Emit shortage
              </button>
              <button
                className="btn-xs"
                onClick={() =>
                  emitEvent("grocerylist.add.request", {
                    items: [
                      { name: it.name, qty: it.min - it.qty, unit: it.unit },
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

  function renderInventoryGrid() {
    if (!filteredItems.length) {
      return (
        <p className="text-xs text-gray-500">
          No inventory items match your filters.
        </p>
      );
    }
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredItems.map((it) => (
          <div
            key={it.id}
            className="border rounded p-2 bg-white flex gap-2 justify-between"
          >
            <div>
              <div className="font-medium">{it.name}</div>
              <div className="text-xs text-gray-500">
                {it.qty} {it.unit} • {it.location || "Pantry"}
              </div>
              <div className="text-xs text-gray-400">
                {it.category || "general"}
                {it.min ? ` • min ${it.min}` : ""}
                {it.source ? ` • from ${it.source}` : ""}
              </div>
            </div>
            <div className="flex flex-col gap-1 items-end">
              <button
                className="btn-xs"
                onClick={() => handleAdjustQty(it.id, +1)}
              >
                +1
              </button>
              <button
                className="btn-xs"
                onClick={() => handleAdjustQty(it.id, -1)}
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
        <p className="text-sm text-gray-500">Loading inventory…</p>
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {renderToolbar()}
      {error ? <p className="text-red-500 text-sm">{error}</p> : null}
      {renderQuickAdd()}
      {renderIncoming()}
      {renderLowItems()}
      {renderInventoryGrid()}
    </div>
  );
}

// -----------------------------------------------------------------------------
// DATA + EVENT HELPERS
// -----------------------------------------------------------------------------

async function loadInventory() {
  // prefer service, else store, else empty
  if (InventoryService && typeof InventoryService.getAll === "function") {
    try {
      const data = await InventoryService.getAll();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn("[InventoryDashboard] InventoryService.getAll failed", e);
    }
  }
  if (InventoryStore && typeof InventoryStore.getAll === "function") {
    try {
      const data = await InventoryStore.getAll();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn("[InventoryDashboard] InventoryStore.getAll failed", e);
    }
  }
  return [];
}

async function upsertInventoryItem(item) {
  if (!item) return;
  if (InventoryService && typeof InventoryService.upsert === "function") {
    try {
      await InventoryService.upsert(item);
      return;
    } catch (e) {
      console.warn(
        "[InventoryDashboard] InventoryService.upsert failed, trying store…",
        e
      );
    }
  }
  if (InventoryStore && typeof InventoryStore.upsert === "function") {
    try {
      await InventoryStore.upsert(item);
    } catch (e) {
      console.warn("[InventoryDashboard] InventoryStore.upsert failed", e);
    }
  }
}

function mapIncomingToCategory(inc) {
  if (!inc) return "general";
  if (inc.source === "garden") return "produce";
  if (inc.source === "animal") return "meat";
  if (inc.source === "preservation") return "preserved";
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
    console.warn("[InventoryDashboard] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatInventoryUpdateForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // Hub is optional — fail silently
    console.warn("[InventoryDashboard] Hub export failed (silent)", e);
  }
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default InventoryDashboard;
