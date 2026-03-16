// File: src/services/selectors/storehouseSelectors.js
// SSA — Storehouse Selectors (production-ready)
//
// Purpose
// - Provide deterministic selectors that assemble "storehouse context"
//   for storehouseShim and storehouse-related reasoner modes.
// - Keep selectors in /src/services (shared, non-agent specific), so shims
//   can import without creating /agents/runtime selector folders.
//
// Design goals
// - Safe offline operation (no network calls).
// - Works even if some DB modules are absent (returns minimal context).
// - Pure-ish: does not mutate inputs; returns a new context object.
// - Extensible: add more fields as your storehouse system expands.
//
// Usage
//   import { selectStorehouseContext } from "@/services/selectors/storehouseSelectors";
//   const ctx = await selectStorehouseContext(input);
//
// Notes
// - This selector is intentionally defensive because your app has multiple
//   evolving DB modules and shims.
// - It tries to pull data if available, but will not crash if modules are missing.

import { toISODateTimeLocal } from "@/engines/scheduling/scheduleHelpers";

/* -------------------------------------------------------------------------- */
/* small utils                                                                */
/* -------------------------------------------------------------------------- */

function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function uniqBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of asArray(arr)) {
    const k = keyFn(item);
    if (k == null) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function pick(obj, keys) {
  const o = safeObj(obj);
  const out = {};
  for (const k of keys) {
    if (typeof o[k] !== "undefined") out[k] = o[k];
  }
  return out;
}

function isoNowLocal() {
  try {
    return toISODateTimeLocal(new Date());
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Attempts to import a module dynamically without breaking build if it doesn't exist.
 * NOTE: Vite/Rollup must resolve the string literal. We only use this for modules
 * that actually exist in your repo. If you're unsure, don't add more here.
 */
async function tryImport(pathLiteral) {
  try {
    const mod = await import(/* @vite-ignore */ pathLiteral);
    return mod || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* DB adapters (best-effort)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort inventory snapshot.
 * We try common module locations you have used in SSA. If none exists,
 * returns null and selector falls back to input-only context.
 */
async function loadInventorySnapshot() {
  // Try your sessions DB module style
  // (You might have inventory DB at "@/db/inventory" or "@/services/db" etc.)
  const candidates = [
    "@/db/inventory",
    "@/db/inventoryDb",
    "@/services/db",
    "@/services/db/index",
  ];

  for (const p of candidates) {
    // only attempt literals; if a path doesn't exist, it will throw and we ignore
    const mod = await tryImport(p);
    if (!mod) continue;

    // Common patterns
    // - mod.inventoryDb.getSnapshot()
    // - mod.db.inventory.toArray()
    // - mod.db.inventoryItems.toArray()
    // - mod.inventory.getAll()
    const invDb = mod.inventoryDb || mod.inventory || null;
    const db = mod.db || null;

    if (invDb && typeof invDb.getSnapshot === "function") {
      return invDb.getSnapshot();
    }

    if (invDb && typeof invDb.getAll === "function") {
      const items = await invDb.getAll();
      return { items: asArray(items) };
    }

    if (db) {
      const table =
        db.inventoryItems || db.inventory || db.storehouse || db.items || null;
      if (table && typeof table.toArray === "function") {
        const items = await table.toArray();
        return { items: asArray(items) };
      }
    }
  }

  return null;
}

/**
 * Best-effort preferences snapshot.
 */
async function loadPreferencesSnapshot() {
  const candidates = ["@/services/preferences", "@/store/PreferencesStore"];
  for (const p of candidates) {
    const mod = await tryImport(p);
    if (!mod) continue;

    if (typeof mod.getPreferences === "function") {
      return mod.getPreferences();
    }
    if (typeof mod.getHouseholdPreferences === "function") {
      return mod.getHouseholdPreferences();
    }
    if (mod.preferences) return mod.preferences;
  }
  return null;
}

/**
 * Best-effort pricebook/coupons snapshot (optional).
 */
async function loadPricingSnapshot() {
  const candidates = ["@/services/pricing", "@/services/pricebook"];
  for (const p of candidates) {
    const mod = await tryImport(p);
    if (!mod) continue;

    if (typeof mod.getPricingSnapshot === "function") {
      return mod.getPricingSnapshot();
    }
    if (mod.pricebook || mod.prices) {
      return { pricebook: mod.pricebook || mod.prices };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Selector                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the Storehouse context used by storehouse reasoner modes.
 *
 * @param {Object} input - shim input payload (from Storehouse Shim)
 * @param {Object} [opts]
 * @param {boolean} [opts.includeInventory=true]
 * @param {boolean} [opts.includePreferences=true]
 * @param {boolean} [opts.includePricing=false]
 * @returns {Promise<Object>} context
 */
export async function selectStorehouseContext(input = {}, opts = {}) {
  const options = {
    includeInventory: opts?.includeInventory !== false,
    includePreferences: opts?.includePreferences !== false,
    includePricing: !!opts?.includePricing,
  };

  const inObj = safeObj(input);

  // Always include a minimal core context that doesn't depend on DB.
  const core = {
    generatedAt: isoNowLocal(),
    // common identity hints (if passed)
    householdId: inObj.householdId || inObj.household_id || null,
    userId: inObj.userId || inObj.user_id || null,
    // control level is frequently used by your shims/modes
    controlLevel: inObj.controlLevel || inObj.control_level || "guided",
    // diet / constraints / planning window are often passed into storehouse planning
    people:
      typeof inObj.people === "number"
        ? inObj.people
        : typeof inObj.householdSize === "number"
        ? inObj.householdSize
        : null,
    days:
      typeof inObj.days === "number"
        ? inObj.days
        : typeof inObj.windowDays === "number"
        ? inObj.windowDays
        : null,
    includeNonFood:
      typeof inObj.includeNonFood === "boolean" ? inObj.includeNonFood : false,
    budget:
      typeof inObj.budget === "number"
        ? inObj.budget
        : typeof inObj.budgetLimit === "number"
        ? inObj.budgetLimit
        : null,
  };

  // Pull any directly-provided context blocks first (caller may already have snapshots)
  const direct = {
    inventorySnapshot: inObj.inventorySnapshot || inObj.inventory || null,
    preferencesSnapshot: inObj.preferencesSnapshot || inObj.preferences || null,
    pricingSnapshot: inObj.pricingSnapshot || null,
  };

  // Best-effort DB pulls (non-fatal)
  let inventorySnapshot = direct.inventorySnapshot;
  let preferencesSnapshot = direct.preferencesSnapshot;
  let pricingSnapshot = direct.pricingSnapshot;

  if (options.includeInventory && !inventorySnapshot) {
    inventorySnapshot = await loadInventorySnapshot();
  }
  if (options.includePreferences && !preferencesSnapshot) {
    preferencesSnapshot = await loadPreferencesSnapshot();
  }
  if (options.includePricing && !pricingSnapshot) {
    pricingSnapshot = await loadPricingSnapshot();
  }

  // Normalize inventory snapshot into a consistent shape expected by modes
  const inv = safeObj(inventorySnapshot);
  const invItemsRaw =
    asArray(inv.items) ||
    asArray(inv.inventoryItems) ||
    asArray(inv.storehouseItems) ||
    [];

  // Keep only basic fields (avoid bloating prompts)
  const invItems = uniqBy(
    invItemsRaw.map((x) => safeObj(x)),
    (x) => x.id || x.inventoryItemId || x.sku || x.key || x.name
  ).map((x) => ({
    ...pick(x, [
      "id",
      "inventoryItemId",
      "sku",
      "key",
      "name",
      "label",
      "category",
      "subCategory",
      "unit",
      "qty",
      "quantity",
      "par",
      "parMin",
      "parMax",
      "min",
      "max",
      "onHand",
      "location",
      "storageLocation",
      "expiresAt",
      "expiration",
      "lastPurchasedAt",
      "lastPurchasePrice",
    ]),
  }));

  const prefs = safeObj(preferencesSnapshot);
  const preferences = {
    // The reasoner modes usually care about diet constraints and “household style”
    diet: prefs.diet || prefs.dietStyle || null,
    restrictions: prefs.restrictions || prefs.allergens || null,
    cuisineProfiles: prefs.cuisineProfiles || prefs.cuisines || null,
    budgetStyle: prefs.budgetStyle || null,
    vendors: prefs.vendors || prefs.vendorPrefs || null,
    pantryStrategy: prefs.pantryStrategy || prefs.storehouseStrategy || null,
    // include raw if you want, but keep prompt size sane:
    // raw: prefs
  };

  const pricing = safeObj(pricingSnapshot);

  // Return context: minimal + normalized snapshots
  return {
    ...core,
    contextVersion: "1.0.0",
    // include direct hints commonly used by modes
    notes: inObj.dietNotes || inObj.notes || null,
    // normalized snapshots
    inventory: {
      items: invItems,
      meta: safeObj(inv.meta || inv.summary || null),
    },
    preferences,
    ...(options.includePricing ? { pricing } : {}),
  };
}

export default {
  selectStorehouseContext,
};
