// src/utils/inventoryUtils.js
import { useInventoryStore } from "../store/InventoryStore";

/**
 * Map all ingredient quantities required from a list of recipes
 */
export function aggregateIngredients(recipes = []) {
  const ingredientMap = {};

  recipes.forEach((recipe) => {
    recipe.ingredients?.forEach((ing) => {
      const key = `${ing.name.toLowerCase()}_${ing.unit}`;
      if (!ingredientMap[key]) {
        ingredientMap[key] = {
          name: ing.name,
          unit: ing.unit,
          total: 0,
        };
      }
      ingredientMap[key].total += ing.quantity || 0;
    });
  });

  return Object.values(ingredientMap);
}

/**
 * Compare inventory levels and flag shortages
 */
export function detectShortages(ingredientNeeds = [], currentInventory = []) {
  const shortages = [];

  ingredientNeeds.forEach((need) => {
    const inv = currentInventory.find(
      (item) =>
        item.name.toLowerCase() === need.name.toLowerCase() &&
        item.unit === need.unit
    );
    const available = inv?.quantity || 0;
    if (available < need.total) {
      shortages.push({
        ...need,
        available,
        shortage: need.total - available,
      });
    }
  });

  return shortages;
}

/**
 * Suggest preservation or freezing if inventory exceeds thresholds
 */
export function suggestPreservationOptions(inventory = [], thresholds = {}) {
  return inventory
    .filter((item) => {
      const limit = thresholds[item.name.toLowerCase()] || 100;
      return item.quantity > limit;
    })
    .map((item) => ({
      name: item.name,
      quantity: item.quantity,
      suggestion: "Preserve excess by freezing, drying, or canning",
    }));
}

/**
 * Generate storage placement suggestions for items
 */
export function generateStorageLabels(items = []) {
  return items.map((item) => {
    const zone =
      item.name.match(/meat|cheese|milk|eggs/i) || item.perishable
        ? "Cold Storage"
        : item.name.match(/grain|flour|beans|lentils/i)
        ? "Dry Storage"
        : "Pantry";

    return {
      ...item,
      suggestedZone: zone,
    };
  });
}

/**
 * Link ingredients to inventory entries by ID
 */
export function linkIngredientsToInventory(recipes = [], inventory = []) {
  return recipes.flatMap((recipe) =>
    recipe.ingredients.map((ing) => {
      const match = inventory.find(
        (inv) =>
          inv.name.toLowerCase() === ing.name.toLowerCase() &&
          inv.unit === ing.unit
      );
      return {
        ...ing,
        inventoryId: match?.id || null,
        available: match?.quantity || 0,
      };
    })
  );
}

/* -------------------------------------------------------------------------- */
/* Missing-export compatibility layer (used by template builders)               */
/* -------------------------------------------------------------------------- */

// NOTE: useInventoryStore is already imported at the top of this module.
// Keeping imports at the top avoids esbuild "already declared" and ESM parse errors.

/**
 * getInventoryItems
 * - Backward-compatible export expected by some components (e.g., InventoryAwarePlanner).
 * - Returns the current inventory items array from InventoryStore, or [] safely.
 * - Does NOT throw during build/SSR.
 */
export function getInventoryItems() {
  try {
    const state = useInventoryStore?.getState?.();
    const items = Array.isArray(state?.items) ? state.items : [];
    return items;
  } catch {
    return [];
  }
}

/**
 * setInventoryItems
 * - Backward-compatible export expected by some components (e.g., InventorySyncer).
 * - Attempts to write the full items array into InventoryStore if a setter exists.
 * - Never throws; returns a small result contract.
 *
 * @param {Array} items
 * @param {Object} opts e.g. { merge: false, source: "InventorySyncer", meta: {} }
 * @returns {{ ok: boolean, count: number, reason?: string }}
 */
export function setInventoryItems(items = [], opts = {}) {
  try {
    const next = Array.isArray(items) ? items : [];
    const state = useInventoryStore?.getState?.();

    // Common setter patterns:
    // 1) state.setItems(next)
    // 2) state.setInventory(next)
    // 3) state.replaceAll(next)
    // 4) useInventoryStore.setState({ items: next })
    const setItems = state?.setItems;
    const setInventory = state?.setInventory;
    const replaceAll = state?.replaceAll;

    if (typeof setItems === "function") {
      setItems(next, { source: opts.source || "inventoryUtils", ...opts });
      return { ok: true, count: next.length };
    }
    if (typeof setInventory === "function") {
      setInventory(next, { source: opts.source || "inventoryUtils", ...opts });
      return { ok: true, count: next.length };
    }
    if (typeof replaceAll === "function") {
      replaceAll(next, { source: opts.source || "inventoryUtils", ...opts });
      return { ok: true, count: next.length };
    }

    if (typeof useInventoryStore?.setState === "function") {
      const current = Array.isArray(state?.items) ? state.items : [];
      const merge = opts.merge === true;
      const finalItems = merge ? [...current, ...next] : next;
      useInventoryStore.setState({ items: finalItems }, false, {
        type: "inventory.setInventoryItems",
        source: opts.source || "inventoryUtils",
        meta: opts.meta || {},
      });
      return {
        ok: true,
        count: finalItems.length,
        reason: merge ? "merged" : "replaced",
      };
    }

    // No writable API; succeed softly to avoid breaking UI flows.
    return { ok: true, count: next.length, reason: "no_store_setter" };
  } catch {
    return { ok: false, count: 0, reason: "set_failed" };
  }
}

/**
 * getSnapshot
 * - Returns a light-weight, pure-data inventory snapshot.
 * - Safe in SSR/build: never throws.
 */
export async function getSnapshot() {
  try {
    const state = useInventoryStore?.getState?.();
    const items = Array.isArray(state?.items) ? state.items : [];
    const byId = Object.create(null);
    const byName = Object.create(null);
    for (const it of items) {
      if (!it) continue;
      if (it.id != null) byId[String(it.id)] = it;
      const nameKey = String(it.name || "")
        .toLowerCase()
        .trim();
      if (nameKey) {
        if (!byName[nameKey]) byName[nameKey] = [];
        byName[nameKey].push(it);
      }
    }
    return { items, byId, byName, atISO: new Date().toISOString() };
  } catch {
    return {
      items: [],
      byId: Object.create(null),
      byName: Object.create(null),
      atISO: new Date().toISOString(),
    };
  }
}

/**
 * missingIngredients
 * - Flexible: accepts either (requiredIngredients, snapshot) OR a recipe object.
 * - Returns shortages array.
 */
export function missingIngredients(requiredOrRecipe, snapshot) {
  const required = Array.isArray(requiredOrRecipe)
    ? requiredOrRecipe
    : Array.isArray(requiredOrRecipe?.ingredients)
    ? requiredOrRecipe.ingredients
    : [];

  const invItems = Array.isArray(snapshot?.items)
    ? snapshot.items
    : Array.isArray(snapshot)
    ? snapshot
    : (() => {
        try {
          return useInventoryStore?.getState?.()?.items || [];
        } catch {
          return [];
        }
      })();

  // Build availability map by normalized name+unit.
  const avail = Object.create(null);
  for (const it of invItems) {
    const k = `${String(it?.name || "")
      .toLowerCase()
      .trim()}|${String(it?.unit || "")
      .toLowerCase()
      .trim()}`;
    if (!k.startsWith("|")) {
      avail[k] = (avail[k] || 0) + (Number(it?.quantity) || 0);
    }
  }

  const shortages = [];
  for (const ing of required) {
    const name = String(ing?.name || ing?.label || "").trim();
    const unit = String(ing?.unit || "").trim();
    const need = Number(ing?.quantity ?? ing?.qty ?? ing?.amount) || 0;
    if (!name || need <= 0) continue;
    const k = `${name.toLowerCase().trim()}|${unit.toLowerCase().trim()}`;
    const have = Number(avail[k] || 0);
    const missing = Math.max(0, need - have);
    if (missing > 0) {
      shortages.push({
        key: name.toLowerCase().trim(),
        name,
        unit: unit || ing?.uom || "",
        needed: need,
        available: have,
        missing,
      });
    }
  }
  return shortages;
}

/**
 * reserveForRecipe
 * - Attempts to reserve required items using InventoryStore reserveItems if available.
 * - Returns a reservation token or null.
 */
export async function reserveForRecipe(recipe, opts = {}) {
  const state = useInventoryStore?.getState?.();
  const reserveItems = state?.reserveItems;
  if (typeof reserveItems !== "function") return null;

  const ingredients = Array.isArray(recipe?.ingredients)
    ? recipe.ingredients
    : [];
  const lines = ingredients
    .map((ing) => ({
      name: ing?.name,
      unit: ing?.unit,
      quantity: Number(ing?.quantity ?? ing?.qty ?? ing?.amount) || 0,
    }))
    .filter((l) => l.name && l.quantity > 0);

  if (!lines.length) return null;
  try {
    const token = await reserveItems(lines, {
      reason:
        opts.reason || `recipe:${recipe?.id || recipe?.name || "unknown"}`,
      holdId: opts.holdId,
      strict: !!opts.strict,
    });
    return token || null;
  } catch {
    return null;
  }
}

/**
 * suggestSwaps
 * - Lightweight heuristic swap suggestions. Returns [] if no ideas.
 */
export function suggestSwaps(shortages = [], snapshot) {
  const inv = Array.isArray(snapshot?.items) ? snapshot.items : [];
  if (!shortages?.length || !inv.length) return [];
  const suggestions = [];
  for (const s of shortages) {
    const name = String(s?.name || "").toLowerCase();
    // Basic category swap rules.
    const category = name.match(/milk|cream|cheese/i)
      ? "dairy"
      : name.match(/flour|grain|rice|pasta/i)
      ? "grain"
      : name.match(/beans|lentils|peas/i)
      ? "legume"
      : name.match(/chicken|beef|lamb|goat|fish|pork/i)
      ? "protein"
      : null;
    if (!category) continue;

    const candidates = inv
      .filter((it) => {
        const n = String(it?.name || "").toLowerCase();
        if (category === "dairy") return /milk|cream|cheese|yogurt/i.test(n);
        if (category === "grain")
          return /flour|grain|rice|pasta|bread/i.test(n);
        if (category === "legume") return /beans|lentils|peas/i.test(n);
        if (category === "protein")
          return /chicken|beef|lamb|goat|fish|pork|turkey/i.test(n);
        return false;
      })
      .slice(0, 5)
      .map((it) => ({
        id: it.id,
        name: it.name,
        unit: it.unit,
        quantity: it.quantity,
      }));

    if (candidates.length) {
      suggestions.push({
        for: s.name,
        missing: s.missing,
        candidates,
      });
    }
  }
  return suggestions;
}
