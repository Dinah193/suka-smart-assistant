/**
 * @file src/agents/skills/guards/inventory.js
 *
 * Inventory guard logic for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - This module is the low-level inventory checker used by:
 *   - the `inventory` guard in `guardsEvaluate.js` (via `env.inventorySnapshot`),
 *   - “Now” resolvers that want to know if a session is runnable with
 *     current storehouse/inventory,
 *   - a swap modal that suggests alternate steps/sessions when key items
 *     are missing or too low.
 *
 * CONTRACT WITH guardsEvaluate:
 * - `guardsEvaluate.inventoryGuard` currently expects:
 *   `env.inventorySnapshot.missingCritical` to be an array of strings.
 *
 * - This file provides:
 *   - `normalizeInventorySnapshot(raw)` → snapshot with:
 *       {
 *         items: { [id: string]: { id, name, qty, unit, minQty, type } },
 *         missingCritical: string[],
 *         lowStock: string[],
 *         lastUpdated: ISO|null,
 *         raw: any
 *       }
 *   - `evaluateInventory(snapshot, stepRequirements, options)` → decision:
 *       {
 *         ok,
 *         decision: 'allow'|'warn'|'block',
 *         reasonCode,
 *         missingCritical: Requirement[],
 *         lowStock: Requirement[],
 *         suggestions,
 *         warnings,
 *         snapshot
 *       }
 *   - `toGuardInventorySnapshot(...)` → a tiny shape that is directly
 *     compatible with `guardsEvaluate.inventoryGuard`.
 */

import { emit } from "../../../services/events/eventBus";

/**
 * @typedef {'ingredient'|'equipment'|'supply'} RequirementType
 */

/**
 * A per-step requirement. These can be produced when you compose sessions
 * from recipes, cleaning plans, garden plans, etc.
 *
 * @typedef {Object} InventoryRequirement
 * @property {string} id              ID that matches an inventory item (preferred)
 * @property {string} [name]          Human label; fallback if id not available
 * @property {RequirementType} [type] 'ingredient'|'equipment'|'supply'
 * @property {number} [quantity]      Quantity needed for this step (default 1)
 * @property {string} [unit]          Unit (e.g., 'g','oz','piece')
 * @property {boolean} [optional]     If true, missing item is not critical
 */

/**
 * Normalized inventory item that lives in the snapshot.
 *
 * @typedef {Object} InventoryItem
 * @property {string} id
 * @property {string} name
 * @property {number} qty      Current quantity (>= 0)
 * @property {string} [unit]
 * @property {number} [minQty] Minimum comfortable level; below this counts as low stock
 * @property {RequirementType} [type]
 */

/**
 * Normalized inventory snapshot used by the guard.
 *
 * @typedef {Object} NormalizedInventorySnapshot
 * @property {Record<string, InventoryItem>} items
 * @property {string[]} missingCritical    // convenience: ids/names of missing required items
 * @property {string[]} lowStock           // convenience: ids/names of low items
 * @property {string|null} lastUpdated
 * @property {any} [raw]                   // Original API/DB shape for debugging
 */

/**
 * Options that influence evaluation behavior.
 *
 * @typedef {Object} InventoryEvaluationOptions
 * @property {boolean} [allowLowStock]     If true, low-stock items only warn, not block
 * @property {boolean} [treatOptionalAsWarnOnly] If true, missing optional items => warn, not block
 */

/**
 * High-level evaluation result for a step’s requirements.
 *
 * @typedef {Object} InventoryEvaluationResult
 * @property {boolean} ok
 * @property {'allow'|'warn'|'block'} decision
 * @property {'ok'|'noRequirements'|'missingCritical'|'lowStock'|'noSnapshot'} reasonCode
 * @property {InventoryRequirement[]} missingCritical
 * @property {InventoryRequirement[]} lowStock
 * @property {string[]} suggestions
 * @property {string[]} warnings
 * @property {NormalizedInventorySnapshot|null} snapshot
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Normalize arbitrary inventory data into a canonical snapshot.
 *
 * Expected raw shapes (examples; this function is tolerant):
 * - A flat list of items:
 *   [{ id, name, qty, unit, minQty, type }]
 * - An object with an `items` array:
 *   { items: [...] }
 * - A keyed object:
 *   { itemsById: { 'flour-kg': { qty: 3, name: 'Flour (kg)' }, ... } }
 *
 * Anything unrecognized just gets passed through into `.raw`.
 *
 * @param {any} raw
 * @returns {NormalizedInventorySnapshot|null}
 */
export function normalizeInventorySnapshot(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  /** @type {Record<string, InventoryItem>} */
  const items = {};

  // Try list-style
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.items)
    ? raw.items
    : null;

  if (list) {
    for (const entry of list) {
      const normalized = normalizeItem(entry);
      if (normalized) {
        items[normalized.id] = normalized;
      }
    }
  }

  // Try keyed-style
  if (!list && raw.itemsById && typeof raw.itemsById === "object") {
    const keys = Object.keys(raw.itemsById);
    for (const key of keys) {
      const entry = raw.itemsById[key];
      const normalized = normalizeItem({ id: key, ...entry });
      if (normalized) {
        items[normalized.id] = normalized;
      }
    }
  }

  // If still empty, we at least return an empty snapshot.
  const lastUpdated = extractLastUpdated(raw);

  /** @type {NormalizedInventorySnapshot} */
  const snapshot = {
    items,
    missingCritical: Array.isArray(raw.missingCritical)
      ? raw.missingCritical.slice()
      : [],
    lowStock: Array.isArray(raw.lowStock) ? raw.lowStock.slice() : [],
    lastUpdated,
    raw,
  };

  return snapshot;
}

/**
 * Evaluate inventory against a set of per-step requirements.
 *
 * Typical usage from a SessionRunner integration:
 *
 * ```js
 * import { normalizeInventorySnapshot, evaluateInventory } from
 *   'src/agents/skills/guards/inventory';
 *
 * const snapshot = normalizeInventorySnapshot(userInventory);
 * const requirements = step.metadata && step.metadata.requirements; // if you store them there
 *
 * const invResult = evaluateInventory(snapshot, requirements, {
 *   allowLowStock: false,
 *   treatOptionalAsWarnOnly: true
 * });
 *
 * // Then pass a compact shape into guardsEvaluate:
 * const guardSnapshot = toGuardInventorySnapshot(invResult);
 * env.inventorySnapshot = guardSnapshot;
 * ```
 *
 * @param {NormalizedInventorySnapshot|null} snapshot
 * @param {InventoryRequirement[]|null|undefined} requirements
 * @param {InventoryEvaluationOptions} [options]
 * @returns {InventoryEvaluationResult}
 */
export function evaluateInventory(snapshot, requirements, options = {}) {
  /** @type {InventoryEvaluationResult} */
  const base = {
    ok: true,
    decision: "allow",
    reasonCode: "ok",
    missingCritical: [],
    lowStock: [],
    suggestions: [],
    warnings: [],
    snapshot: snapshot || null,
  };

  if (!snapshot) {
    const res = {
      ...base,
      ok: true, // allow by default; SessionRunner UI can still show “Inventory unknown”
      decision: "warn",
      reasonCode: "noSnapshot",
      warnings: [
        "Inventory data unavailable; treating as sufficient by default.",
      ],
    };
    safeEmitInventoryEvaluated(res);
    return res;
  }

  const reqs = Array.isArray(requirements) ? requirements : [];
  if (!reqs.length) {
    const res = {
      ...base,
      ok: true,
      decision: "allow",
      reasonCode: "noRequirements",
    };
    safeEmitInventoryEvaluated(res);
    return res;
  }

  const allowLowStock = !!options.allowLowStock;
  const treatOptionalAsWarnOnly = !!options.treatOptionalAsWarnOnly;

  /** @type {InventoryRequirement[]} */
  const missingCritical = [];
  /** @type {InventoryRequirement[]} */
  const lowStock = [];

  for (const req of reqs) {
    const normReq = normalizeRequirement(req);
    const item =
      snapshot.items[normReq.id] ||
      findItemByName(snapshot.items, normReq.name);

    if (!item || !Number.isFinite(item.qty)) {
      // If optional and configured that way, warn but don't block.
      if (normReq.optional && treatOptionalAsWarnOnly) {
        lowStock.push(normReq); // treat as “soft issue”
      } else {
        missingCritical.push(normReq);
      }
      continue;
    }

    const qtyHave = item.qty;
    const qtyNeed = normReq.quantity ?? 1;

    if (qtyHave < qtyNeed) {
      // Not enough for this step.
      if (normReq.optional && treatOptionalAsWarnOnly) {
        lowStock.push(normReq);
      } else {
        missingCritical.push(normReq);
      }
      continue;
    }

    // Enough for this step, but check minQty for “low stock” warnings.
    const minQty = Number.isFinite(item.minQty) ? Number(item.minQty) : null;
    if (minQty != null && qtyHave <= minQty) {
      lowStock.push(normReq);
    }
  }

  let decision = /** @type {'allow'|'warn'|'block'} */ ("allow");
  /** @type {'ok'|'noRequirements'|'missingCritical'|'lowStock'|'noSnapshot'} */
  let reasonCode = "ok";
  const suggestions = [];
  const warnings = [...base.warnings];

  if (missingCritical.length) {
    decision = "block";
    reasonCode = "missingCritical";
    suggestions.push(
      "Add missing items to your shopping list or storehouse pickup.",
      "Use the swap modal to choose a different session or step that fits your current inventory."
    );
  } else if (lowStock.length && !allowLowStock) {
    decision = "warn";
    reasonCode = "lowStock";
    suggestions.push(
      "Consider replacing low-stock items or reducing batch size.",
      "Add low-stock items to your shopping list to avoid future shortages."
    );
  }

  const ok = decision !== "block";

  const result = {
    ...base,
    ok,
    decision,
    reasonCode,
    missingCritical,
    lowStock,
    suggestions,
    warnings,
  };

  safeEmitInventoryEvaluated(result);
  return result;
}

/**
 * Convert an evaluation result (or raw snapshot) to the compact shape
 * expected by `guardsEvaluate.inventoryGuard`:
 *
 * `{ missingCritical: string[] }`
 *
 * You can also optionally carry lowStock and other hints if you want to
 * extend the guard logic later.
 *
 * @param {InventoryEvaluationResult|NormalizedInventorySnapshot|null} input
 * @returns {{ missingCritical: string[], lowStock?: string[], lastUpdated?: string|null }}
 */
export function toGuardInventorySnapshot(input) {
  if (!input) {
    return { missingCritical: [] };
  }

  // If we already have an evaluation result
  // @ts-ignore
  if (input.reasonCode && input.snapshot !== undefined) {
    /** @type {InventoryEvaluationResult} */
    const res = /** @type any */ (input);
    const missingNames = res.missingCritical.map((r) => r.name || r.id);
    const lowNames = res.lowStock.map((r) => r.name || r.id);

    return {
      missingCritical: missingNames,
      lowStock: lowNames,
      lastUpdated: res.snapshot ? res.snapshot.lastUpdated : null,
    };
  }

  /** @type {NormalizedInventorySnapshot} */
  const snapshot = /** @type any */ (input);
  return {
    missingCritical: Array.isArray(snapshot.missingCritical)
      ? snapshot.missingCritical.slice()
      : [],
    lowStock: Array.isArray(snapshot.lowStock) ? snapshot.lowStock.slice() : [],
    lastUpdated: snapshot.lastUpdated,
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a raw item into an InventoryItem.
 *
 * @param {any} raw
 * @returns {InventoryItem|null}
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : typeof raw.sku === "string" && raw.sku.trim()
      ? raw.sku.trim()
      : null;

  if (!id) return null;

  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;

  const qty = Number.isFinite(raw.qty)
    ? Number(raw.qty)
    : Number.isFinite(raw.quantity)
    ? Number(raw.quantity)
    : 0;

  const unit =
    typeof raw.unit === "string" && raw.unit.trim()
      ? raw.unit.trim()
      : typeof raw.uom === "string" && raw.uom.trim()
      ? raw.uom.trim()
      : undefined;

  const minQty = Number.isFinite(raw.minQty) ? Number(raw.minQty) : undefined;

  const type =
    raw.type === "ingredient" ||
    raw.type === "equipment" ||
    raw.type === "supply"
      ? raw.type
      : undefined;

  return {
    id,
    name,
    qty: qty < 0 ? 0 : qty,
    unit,
    minQty,
    type,
  };
}

/**
 * Normalize a per-step requirement, filling safe defaults.
 *
 * @param {InventoryRequirement} req
 * @returns {InventoryRequirement}
 */
function normalizeRequirement(req) {
  const safe =
    req || /** @type {InventoryRequirement} */ ({ id: "", quantity: 1 });
  const id =
    typeof safe.id === "string" && safe.id.trim()
      ? safe.id.trim()
      : safe.name && safe.name.trim()
      ? safe.name.trim()
      : "unknown";

  const name =
    typeof safe.name === "string" && safe.name.trim() ? safe.name.trim() : id;

  const quantity =
    Number.isFinite(safe.quantity) && safe.quantity > 0
      ? Number(safe.quantity)
      : 1;

  const type =
    safe.type === "ingredient" ||
    safe.type === "equipment" ||
    safe.type === "supply"
      ? safe.type
      : "ingredient";

  const unit =
    typeof safe.unit === "string" && safe.unit.trim()
      ? safe.unit.trim()
      : undefined;

  const optional = !!safe.optional;

  return {
    id,
    name,
    quantity,
    unit,
    type,
    optional,
  };
}

/**
 * Try to find an item by name (case-insensitive).
 *
 * @param {Record<string, InventoryItem>} items
 * @param {string|undefined} name
 * @returns {InventoryItem|undefined}
 */
function findItemByName(items, name) {
  if (!name) return undefined;
  const target = name.trim().toLowerCase();
  const ids = Object.keys(items);
  for (const id of ids) {
    const item = items[id];
    if (item.name && item.name.toLowerCase() === target) {
      return item;
    }
  }
  return undefined;
}

/**
 * Extract a "lastUpdated" field as ISO string, if present.
 *
 * @param {any} raw
 * @returns {string|null}
 */
function extractLastUpdated(raw) {
  if (!raw || typeof raw !== "object") return null;

  const ts =
    raw.lastUpdated ||
    raw.updatedAt ||
    raw.updated_at ||
    (raw.meta && raw.meta.lastUpdated);

  if (!ts) return null;

  if (typeof ts === "number") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Event emission                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emit `inventory.evaluated` for telemetry / debugging.
 *
 * Payload:
 * {
 *   type: 'inventory.evaluated',
 *   ts: ISO8601,
 *   source: 'guards.inventory',
 *   data: InventoryEvaluationResult
 * }
 *
 * @param {InventoryEvaluationResult} result
 */
function safeEmitInventoryEvaluated(result) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "inventory.evaluated",
      ts: new Date().toISOString(),
      source: "guards.inventory",
      data: result,
    });
  } catch (_err) {
    // Never crash guard logic because of eventBus failures.
    // console.warn('[guards.inventory] Failed to emit inventory.evaluated', _err);
  }
}
