// C:\Users\larho\suka-smart-assistant\src\domain\inventory\InventorySessionEngine.js
// Handles inventory updates and shortage detection
// -----------------------------------------------------------------------------
// HOW THIS FITS THE SSA PIPELINE
// imports (recipes, garden harvests, animal/butchery yields, cleaning supplies,
// storehouse goals, video/how-to)
//   → ImportService → normalized payloads → emit import.parsed
//   → InventorySessionEngine (THIS FILE) listens for / is called with:
//       - “add these items to inventory”  (direction: increment)
//       - “we used these items in a session” (direction: decrement)
//       - “we detected these items are low” → emits inventory.shortage.detected
//       - “we need to build a restock session / shopping list / storehouse move”
//   → emits to shared eventBus:
//       - inventory.updated
//       - inventory.shortage.detected
//       - inventory.session.generated (restock / transfer / audit)
//   → automation.runtime can schedule or suggest sessions
//   → (optional) export to Hub if featureFlags.familyFundMode = true
//
// GOALS
// - Forward-thinking: supports new domains (preservation, animal, storehouse) by treating
//   every incoming delta the same way: { item, qty, unit, direction, source, tags }
// - Event-driven: always emits { type, ts, source, data } with ISO timestamps
// - Defensive: if InventoryService / InventoryStore isn't present, we still emit events
// - Data-changing ops → exportToHubIfEnabled
//
// PUBLIC API (used by SSA):
//   InventorySessionEngine.applyDeltas(deltas, options?)
//   InventorySessionEngine.generateRestockSession(lowItems, options?)
//   InventorySessionEngine.processImportAsInventory(importPayload, options?)
//   InventorySessionEngine.detectShortages(items?, options?)
//   InventorySessionEngine.onExternalInventoryUpdated(payload)  ← for bus handlers
//
// This is a *logic* module, not a React component.
// -----------------------------------------------------------------------------

import eventBus from "../../services/eventBus";
import featureFlags from "../../config/featureFlags.json";
import { formatInventoryUpdateForHub } from "../../services/HubPacketFormatter";
import FamilyFundConnector from "../../services/FamilyFundConnector";

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

const SOURCE_ID = "domain.inventory.InventorySessionEngine";

const InventorySessionEngine = {
  /**
   * Main entry point: apply one or more inventory deltas.
   * A delta is:
   *   { item: "flour", qty: 2, unit: "lb", direction: "increment"|"decrement", location?, source?, tags? }
   *
   * @param {Array} deltas
   * @param {Object} options
   *  options = {
   *    emitShortage: true,
   *    detectAfter: true,
   *    allowNegative: false,
   *    reason: "garden.harvest" | "animal.butchery" | "session.use" | ...
   *  }
   * @returns {Promise<void>}
   */
  async applyDeltas(deltas, options = {}) {
    if (!Array.isArray(deltas) || !deltas.length) {
      console.warn("[InventorySessionEngine] applyDeltas: no deltas");
      return;
    }

    const allowNegative = options.allowNegative || false;
    const detectAfter = options.detectAfter !== false;
    const reason = options.reason || "manual";

    // 1. fetch current inventory (for shortage checks & merge)
    const current = await loadInventorySafe();

    // 2. apply each delta → build updated items
    const updatedItems = applyDeltasToInventory(current, deltas, { allowNegative });

    // 3. persist updated items back
    await persistInventorySafe(updatedItems);

    // 4. emit inventory.updated
    const updatedEvt = emitEvent("inventory.updated", {
      deltas,
      reason,
      final: updatedItems,
    });
    await exportToHubIfEnabled(updatedEvt);

    // 5. detect shortages
    if (detectAfter) {
      const shortages = detectShortagesFromItems(updatedItems);
      if (shortages.length) {
        const shortEvt = emitEvent("inventory.shortage.detected", {
          items: shortages,
        });
        await exportToHubIfEnabled(shortEvt);
      }
    }
  },

  /**
   * Generate a restock / resupply / grocery or storehouse session from low items.
   * @param {Array} lowItems
   * @param {Object} options
   *  options = { target: "grocery"|"storehouse"|"production", schedule?: {...} }
   * @returns {Promise<Object>} session
   */
  async generateRestockSession(lowItems, options = {}) {
    if (!Array.isArray(lowItems) || !lowItems.length) {
      console.warn("[InventorySessionEngine] generateRestockSession: no low items");
      return null;
    }

    const target = options.target || "grocery";
    const id = makeId("invSess");
    const nowIso = new Date().toISOString();

    const tasks = lowItems.map((li, idx) => ({
      id: makeId("invTask"),
      order: idx + 1,
      label: buildRestockLabel(li, target),
      type: "restock",
      item: li.name,
      requiredQty: Math.max((li.min || 0) - (li.qty || 0), 1),
      unit: li.unit || "ea",
      location: li.location || "Pantry",
      target,
      tags: ["inventory", "restock", target],
      duration: 3,
    }));

    const session = {
      id,
      ts: nowIso,
      domain: "inventory",
      source: SOURCE_ID,
      title: buildRestockSessionTitle(target),
      tasks,
      schedule: {
        start: options.schedule?.start || nowIso,
        policy: options.schedule?.policy || "asap",
      },
      meta: {
        target,
        itemCount: tasks.length,
      },
      status: "pending",
    };

    const evt = emitEvent("inventory.session.generated", {
      session,
    });
    await exportToHubIfEnabled(evt);

    return session;
  },

  /**
   * Turn an import payload (NOT recipe-only!) into inventory additions.
   * Supports: cleaning, garden/seed (as produce), animal/butchery (as meat), storehouse
   * @param {Object|Array} importPayload
   * @param {Object} options
   * @returns {Promise<void>}
   */
  async processImportAsInventory(importPayload, options = {}) {
    const arr = Array.isArray(importPayload) ? importPayload : [importPayload];
    const deltas = arr
      .map((imp) => normalizeImportToInventoryDelta(imp))
      .filter(Boolean);

    if (!deltas.length) {
      console.warn("[InventorySessionEngine] processImportAsInventory: nothing to convert");
      return;
    }

    await this.applyDeltas(deltas, {
      ...options,
      reason: "import",
    });
  },

  /**
   * Detect shortages from given items OR from persisted inventory.
   * @param {Array} items
   * @param {Object} options
   */
  async detectShortages(items, options = {}) {
    const base = Array.isArray(items) && items.length ? items : await loadInventorySafe();
    const shortages = detectShortagesFromItems(base);
    if (!shortages.length) return;
    const evt = emitEvent("inventory.shortage.detected", {
      items: shortages,
      reason: options.reason || "manual-detect",
    });
    await exportToHubIfEnabled(evt);
  },

  /**
   * Event-bus friendly: call this when you receive an “inventory.updated” from elsewhere
   * to re-run shortage detection or generate restock sessions.
   * @param {Object} payload
   */
  async onExternalInventoryUpdated(payload) {
    const items = await loadInventorySafe();
    const shortages = detectShortagesFromItems(items);
    if (!shortages.length) return;
    const shortEvt = emitEvent("inventory.shortage.detected", {
      items: shortages,
      reason: "external-update",
    });
    await exportToHubIfEnabled(shortEvt);
  },
};

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

/**
 * Apply deltas to current inventory list.
 * We treat inventory as an array of items:
 *   { id, name, qty, unit, location, category, min, source }
 *
 * @param {Array} current
 * @param {Array} deltas
 * @param {Object} options
 * @returns {Array} updated inventory
 */
function applyDeltasToInventory(current, deltas, options = {}) {
  const allowNegative = options.allowNegative || false;
  const map = new Map();

  // index current items by lowercased name + location
  (current || []).forEach((it) => {
    const key = makeInventoryKey(it.name, it.location);
    map.set(key, { ...it });
  });

  for (const d of deltas) {
    if (!d || !d.item) continue;
    const name = d.item;
    const location = d.location || "Pantry";
    const key = makeInventoryKey(name, location);
    const cur = map.get(key) || {
      id: makeId("inv"),
      name,
      qty: 0,
      unit: d.unit || "ea",
      location,
      category: d.category || "general",
      min: 0,
      source: d.source || null,
    };

    const qty = Number(d.qty) || 0;
    let nextQty = cur.qty || 0;

    if (d.direction === "decrement") {
      nextQty = nextQty - qty;
    } else {
      // default increment
      nextQty = nextQty + qty;
    }

    if (!allowNegative && nextQty < 0) {
      nextQty = 0;
    }

    cur.qty = nextQty;
    // update unit/category if provided
    if (d.unit) cur.unit = d.unit;
    if (d.category) cur.category = d.category;
    if (typeof d.min === "number") cur.min = d.min;

    map.set(key, cur);
  }

  return Array.from(map.values());
}

/**
 * Detect shortages from a list of inventory items
 * @param {Array} items
 * @returns {Array}
 */
function detectShortagesFromItems(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return items
    .filter((it) => {
      const qty = Number(it.qty) || 0;
      const min = Number(it.min) || 0;
      return min > 0 && qty <= min;
    })
    .map((it) => ({
      name: it.name,
      qty: Number(it.qty) || 0,
      min: Number(it.min) || 0,
      unit: it.unit || "ea",
      location: it.location || "Pantry",
      category: it.category || "general",
    }));
}

/**
 * Normalize ANY supported import to an inventory delta.
 * Supports:
 *  - { domain: "garden", crop, qty, unit }
 *  - { domain: "animal", parts: [...] }
 *  - { domain: "cleaning", supplies: [...] }
 *  - { domain: "storehouse", items: [...] }
 */
function normalizeImportToInventoryDelta(imp) {
  if (!imp) return null;

  // garden / seed → produce
  if (imp.domain === "garden" || imp.domain === "seed") {
    return {
      item: imp.crop || imp.title || "Garden produce",
      qty: imp.qty || 1,
      unit: imp.unit || "ea",
      direction: "increment",
      category: "produce",
      location: "Pantry",
      source: "import.garden",
    };
  }

  // animal / butchery → meat
  if (imp.domain === "animal" || imp.domain === "butchery") {
    if (Array.isArray(imp.parts) && imp.parts.length) {
      // for simplicity, return only first as delta; the rest will be applied separately upstream
      const p = imp.parts[0];
      return {
        item: p.name,
        qty: p.qty || 1,
        unit: p.unit || "lb",
        direction: "increment",
        category: "meat",
        location: "Freezer",
        source: "import.animal",
      };
    }
    return {
      item: imp.species ? `meat (${imp.species})` : "meat (animal)",
      qty: imp.estimatedMeat || 1,
      unit: "lb",
      direction: "increment",
      category: "meat",
      location: "Freezer",
      source: "import.animal",
    };
  }

  // cleaning → supplies
  if (imp.domain === "cleaning") {
    return {
      item: imp.name || "cleaning supply",
      qty: imp.qty || 1,
      unit: imp.unit || "ea",
      direction: "increment",
      category: "cleaning",
      location: "Pantry",
      source: "import.cleaning",
    };
  }

  // storehouse → inventory (local)
  if (imp.domain === "storehouse") {
    const first = Array.isArray(imp.items) ? imp.items[0] : null;
    if (first) {
      return {
        item: first.name,
        qty: first.qty || 1,
        unit: first.unit || "ea",
        direction: "increment",
        category: "general",
        location: "Storehouse",
        source: "import.storehouse",
      };
    }
    return {
      item: imp.name || "storehouse item",
      qty: imp.qty || 1,
      unit: imp.unit || "ea",
      direction: "increment",
      category: "general",
      location: "Storehouse",
      source: "import.storehouse",
    };
  }

  // fallback
  return {
    item: imp.name || "Imported item",
    qty: imp.qty || 1,
    unit: imp.unit || "ea",
    direction: "increment",
    category: "general",
    location: "Pantry",
    source: "import",
  };
}

/**
 * Persist inventory via service/store
 */
async function persistInventorySafe(items) {
  if (InventoryService && typeof InventoryService.bulkReplace === "function") {
    try {
      await InventoryService.bulkReplace(items);
      return;
    } catch (e) {
      console.warn("[InventorySessionEngine] InventoryService.bulkReplace failed", e);
    }
  }
  if (InventoryStore && typeof InventoryStore.bulkReplace === "function") {
    try {
      await InventoryStore.bulkReplace(items);
      return;
    } catch (e) {
      console.warn("[InventorySessionEngine] InventoryStore.bulkReplace failed", e);
    }
  }
}

/**
 * Load inventory via service/store
 */
async function loadInventorySafe() {
  if (InventoryService && typeof InventoryService.getAll === "function") {
    try {
      const data = await InventoryService.getAll();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn("[InventorySessionEngine] InventoryService.getAll failed", e);
    }
  }
  if (InventoryStore && typeof InventoryStore.getAll === "function") {
    try {
      const data = await InventoryStore.getAll();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn("[InventorySessionEngine] InventoryStore.getAll failed", e);
    }
  }
  return [];
}

// -----------------------------------------------------------------------------
// EVENT / HUB
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
    console.warn("[InventorySessionEngine] eventBus not available for", type);
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
    console.warn("[InventorySessionEngine] Hub export failed (silent)", e);
  }
}

// -----------------------------------------------------------------------------
// MISC
// -----------------------------------------------------------------------------

function makeInventoryKey(name, location) {
  return `${(name || "").toLowerCase()}|${(location || "Pantry").toLowerCase()}`;
}

function buildRestockLabel(item, target) {
  const missing = Math.max((item.min || 0) - (item.qty || 0), 1);
  return `Restock ${item.name} → ${target} (+${missing} ${item.unit || "ea"})`;
}

function buildRestockSessionTitle(target) {
  if (target === "storehouse") return "Restock → Storehouse";
  if (target === "production") return "Restock → Production / Processing";
  return "Restock → Grocery / Local Supplier";
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default InventorySessionEngine;
