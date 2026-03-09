/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\GapChecker.js
//
// GapChecker (FTT)
// ----------------
// Purpose
// - Compare FTT provisioning targets against what the household already has
//   (inventory + storehouse + FTT component inventory/batches) and produce
//   deterministic "gaps" and "actions" (buy, cook, preserve, garden, animals).
//
// Design goals
// - Local-first, deterministic, non-AI
// - Safe if some tables are missing
// - Works with partial data: if storehouse isn't used yet, still works with inventory
// - Returns a stable, structured result that downstream UI/engines can use
//
// Primary inputs
// - Targets (typically from ftt_provisioning_targets and/or a planner output):
//   { householdId, horizonStartISO, horizonDays, items:[{ itemKey, componentKey?, qty:{value,unit}, kind?, priority? }], ... }
//
// Optional context inputs
// - componentInventory (ftt_component_inventory): normalized FTT components with on-hand quantities
// - componentBatches (ftt_component_batches): recent batch outputs and status
// - inventory: household inventory line items (sku/name/category/quantity/unit)
// - storehouse: storehouse planned/actual quantities by bucket/season/cycle/itemKey
//
// Output
// - {
//     householdId,
//     window:{startISO,horizonDays},
//     computedAt,
//     totals:{ targetLines, consideredLines, gaps },
//     lines:[
//       {
//         itemKey, componentKey, targetQty, onHandQty, gapQty,
//         coveragePct, confidence,
//         sources:{ inventory, storehouse, components, batches },
//         suggestedActions:[ ... ],
//         notes:[ ... ]
//       }
//     ],
//     actions:[ ... flattened unique actions ... ],
//     debug:{ ... }
//   }
//
// NOTE: This file intentionally does not attempt any "unit conversions" beyond
// same-unit arithmetic. If a unit mismatch occurs, it flags and suggests an action.
// If you later add ConversionEngine/unit maps, you can plug it in via options.convert().

import db from "@/services/db";

/* -------------------------------------------------------------------------- */
/* Utilities */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, safeNum(n, min)));
}

function hasTable(name) {
  try {
    void db.table(name);
    return true;
  } catch {
    return false;
  }
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function toDayKey(iso) {
  return safeStr(iso, nowIso()).slice(0, 10);
}

function normalizeQty(qty) {
  // Accept {value,unit} or {amount:{value,unit}} or legacy {qty,unit}
  if (!qty || typeof qty !== "object") return null;

  if (qty.amount && typeof qty.amount === "object") {
    const v = safeNum(qty.amount.value, NaN);
    const u = safeStr(qty.amount.unit, "").trim();
    if (Number.isFinite(v) && u) return { value: v, unit: u };
  }

  const v = safeNum(qty.value ?? qty.qty, NaN);
  const u = safeStr(qty.unit, "").trim();
  if (Number.isFinite(v) && u) return { value: v, unit: u };

  return null;
}

function addQty(a, b) {
  // only add if same unit
  const qa = normalizeQty(a);
  const qb = normalizeQty(b);
  if (!qa || !qb) return null;
  if (qa.unit !== qb.unit) return null;
  return { value: qa.value + qb.value, unit: qa.unit };
}

function subQty(a, b) {
  const qa = normalizeQty(a);
  const qb = normalizeQty(b);
  if (!qa || !qb) return null;
  if (qa.unit !== qb.unit) return null;
  return { value: qa.value - qb.value, unit: qa.unit };
}

function maxQty(a, b) {
  const qa = normalizeQty(a);
  const qb = normalizeQty(b);
  if (!qa) return qb;
  if (!qb) return qa;
  if (qa.unit !== qb.unit) return qa; // arbitrary, but stable
  return qa.value >= qb.value ? qa : qb;
}

function pct(n, d) {
  const nn = safeNum(n, 0);
  const dd = safeNum(d, 0);
  if (dd <= 0) return 0;
  return clamp((nn / dd) * 100, 0, 100);
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Data loaders */
/* -------------------------------------------------------------------------- */

async function loadTargetsFromDb({ targetsId } = {}) {
  if (!targetsId) return null;
  if (!hasTable("ftt_provisioning_targets")) return null;
  try {
    return await db.ftt_provisioning_targets.get(safeStr(targetsId));
  } catch {
    return null;
  }
}

async function loadInventoryByHousehold(/* householdId */) {
  // SSA inventory table doesn't include householdId in earlier schema, so treat as "global household"
  if (!hasTable("inventory")) return [];
  try {
    return await db.inventory.toArray();
  } catch {
    return [];
  }
}

async function loadStorehouseByHousehold(/* householdId */) {
  // Same as inventory: may not include householdId in early schema. If later added, filter here.
  if (!hasTable("storehouse")) return [];
  try {
    return await db.storehouse.toArray();
  } catch {
    return [];
  }
}

async function loadComponentInventory(householdId) {
  if (!hasTable("ftt_component_inventory")) return [];
  const h = safeStr(householdId);
  try {
    // uses [householdId+componentKey] and [householdId+itemKey] but we want all for household
    // If householdId index exists, use it; otherwise scan.
    // Schema includes householdId as indexed field, so where should work.
    return await db.ftt_component_inventory
      .where("householdId")
      .equals(h)
      .toArray();
  } catch {
    try {
      const all = await db.ftt_component_inventory.toArray();
      return all.filter((r) => safeStr(r.householdId) === h);
    } catch {
      return [];
    }
  }
}

async function loadComponentBatches(householdId, { sinceISO = null } = {}) {
  if (!hasTable("ftt_component_batches")) return [];
  const h = safeStr(householdId);
  const sinceDay = sinceISO ? toDayKey(sinceISO) : null;

  try {
    const rows = await db.ftt_component_batches
      .where("householdId")
      .equals(h)
      .toArray();
    if (!sinceDay) return rows;
    return rows.filter(
      (r) => toDayKey(r.batchDateISO || r.createdAt || r.updatedAt) >= sinceDay,
    );
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization for inputs */
/* -------------------------------------------------------------------------- */

function normalizeTargetLine(line) {
  const l = line && typeof line === "object" ? line : {};
  const targetQty = normalizeQty(l.qty || l.amount || l.quantity);
  return {
    itemKey: safeStr(l.itemKey || l.item || l.sku, "").trim(),
    componentKey: safeStr(l.componentKey || l.component || "", "").trim(),
    kind: safeStr(l.kind || "target"),
    priority: safeStr(l.priority || "normal"),
    qty: targetQty,
    // optional metadata
    title: safeStr(l.title || "", ""),
    tags: Array.isArray(l.tags) ? l.tags.map(String).filter(Boolean) : [],
    meta: l.meta && typeof l.meta === "object" ? l.meta : {},
  };
}

function normalizeTargetsDoc(targets, fallbackHouseholdId) {
  const t = targets && typeof targets === "object" ? targets : {};
  const window = {
    startISO: safeStr(
      t.horizonStartISO || t.startISO || t.window?.startISO || nowIso(),
    ),
    horizonDays: clamp(t.horizonDays ?? t.window?.horizonDays ?? 14, 1, 365),
  };

  const itemsRaw = Array.isArray(t.items)
    ? t.items
    : Array.isArray(t.targets)
      ? t.targets
      : [];
  const items = itemsRaw
    .map(normalizeTargetLine)
    .filter((x) => x.itemKey || x.componentKey);

  return {
    id: safeStr(t.id || t.targetsId || "", ""),
    householdId: safeStr(t.householdId || fallbackHouseholdId || "", ""),
    window,
    items,
    meta: t.meta && typeof t.meta === "object" ? t.meta : {},
    createdAt: safeStr(t.createdAt, ""),
    updatedAt: safeStr(t.updatedAt, ""),
    status: safeStr(t.status || "computed"),
  };
}

/* -------------------------------------------------------------------------- */
/* Core aggregation logic */
/* -------------------------------------------------------------------------- */

function indexInventory(inventoryRows) {
  // inventory schema: "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag"
  // We'll index by:
  // - sku (preferred) and fallback by name lowercased
  const byItemKey = new Map();

  for (const r of inventoryRows || []) {
    const sku = safeStr(r.sku || r.itemKey || r.key, "").trim();
    const name = safeStr(r.name || "", "").trim();
    const keyCandidates = [];
    if (sku) keyCandidates.push(sku);
    if (name) keyCandidates.push(`name:${name.toLowerCase()}`);

    const qty = normalizeQty({ value: r.quantity, unit: r.unit });
    for (const k of keyCandidates) {
      const prev = byItemKey.get(k);
      const next = prev ? addQty(prev, qty) || prev : qty;
      byItemKey.set(k, next);
    }
  }

  return { byItemKey };
}

function indexStorehouse(storehouseRows) {
  // storehouse schema: "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt"
  const byItemKey = new Map();
  for (const r of storehouseRows || []) {
    const itemKey = safeStr(r.itemKey || r.sku || r.name, "").trim();
    if (!itemKey) continue;

    const qty = normalizeQty({
      value: r.actualQuantity ?? r.plannedQuantity,
      unit: r.unit, // may not exist in your schema; if absent, unit mismatch is handled later
    });

    // If unit missing, store as null-ish; we still track count with unknown unit by using a pseudo-unit.
    const safeQty =
      qty ||
      (r.actualQuantity != null
        ? { value: safeNum(r.actualQuantity, 0), unit: safeStr(r.unit, "unit") }
        : r.plannedQuantity != null
          ? {
              value: safeNum(r.plannedQuantity, 0),
              unit: safeStr(r.unit, "unit"),
            }
          : null);

    if (!safeQty) continue;

    const prev = byItemKey.get(itemKey);
    const next = prev ? addQty(prev, safeQty) || prev : safeQty;
    byItemKey.set(itemKey, next);
  }
  return { byItemKey };
}

function indexComponentInventory(componentRows) {
  // ftt_component_inventory recommended: { householdId, componentKey, itemKey, qty:{value,unit}, ... }
  const byComponentKey = new Map();
  const byItemKey = new Map();

  for (const r of componentRows || []) {
    const componentKey = safeStr(r.componentKey || r.component, "").trim();
    const itemKey = safeStr(r.itemKey || r.item, "").trim();
    const qty = normalizeQty(r.qty || r.amount || r.quantity);

    if (componentKey && qty) {
      const prev = byComponentKey.get(componentKey);
      const next = prev ? addQty(prev, qty) || prev : qty;
      byComponentKey.set(componentKey, next);
    }
    if (itemKey && qty) {
      const prev = byItemKey.get(itemKey);
      const next = prev ? addQty(prev, qty) || prev : qty;
      byItemKey.set(itemKey, next);
    }
  }

  return { byComponentKey, byItemKey };
}

function indexBatches(batchRows, { includeStatuses = ["completed"] } = {}) {
  // We'll use batches to increase "on hand" if completed and outputs indicate qty.
  const include = new Set(includeStatuses.map(String));
  const byComponentKey = new Map();
  const byItemKey = new Map();

  for (const b of batchRows || []) {
    const status = safeStr(b.status || "completed");
    if (!include.has(status)) continue;

    const outputs = Array.isArray(b.outputs) ? b.outputs : [];
    for (const out of outputs) {
      const componentKey = safeStr(
        out.componentKey || b.componentKey || "",
        "",
      ).trim();
      const itemKey = safeStr(out.itemKey || "", "").trim();
      const qty = normalizeQty(out.qty || out.amount || out.quantity);

      if (componentKey && qty) {
        const prev = byComponentKey.get(componentKey);
        const next = prev ? addQty(prev, qty) || prev : qty;
        byComponentKey.set(componentKey, next);
      }
      if (itemKey && qty) {
        const prev = byItemKey.get(itemKey);
        const next = prev ? addQty(prev, qty) || prev : qty;
        byItemKey.set(itemKey, next);
      }
    }
  }

  return { byComponentKey, byItemKey };
}

function computeOnHand({
  targetLine,
  inventoryIndex,
  storehouseIndex,
  componentIndex,
  batchIndex,
  options,
}) {
  const { itemKey, componentKey } = targetLine;
  const notes = [];
  const sources = {
    inventory: null,
    storehouse: null,
    components: null,
    batches: null,
  };

  // Optional conversion hook: (fromQty, toUnit) => qtyInToUnit or null
  const convert =
    options?.convert && typeof options.convert === "function"
      ? options.convert
      : null;

  const targetQty = normalizeQty(targetLine.qty);

  // Gather candidates for on-hand:
  const candidates = [];

  // Inventory (by sku)
  if (itemKey) {
    const inv = inventoryIndex.byItemKey.get(itemKey) || null;
    if (inv) {
      sources.inventory = inv;
      candidates.push({ source: "inventory", qty: inv });
    } else {
      // fallback by name-key if caller uses name-style itemKey
      const inv2 =
        inventoryIndex.byItemKey.get(`name:${itemKey.toLowerCase()}`) || null;
      if (inv2) {
        sources.inventory = inv2;
        candidates.push({
          source: "inventory",
          qty: inv2,
          note: "matched_by_name",
        });
      }
    }
  }

  // Storehouse
  if (itemKey) {
    const sh = storehouseIndex.byItemKey.get(itemKey) || null;
    if (sh) {
      sources.storehouse = sh;
      candidates.push({ source: "storehouse", qty: sh });
    }
  }

  // Component inventory (componentKey preferred; itemKey fallback)
  if (componentKey) {
    const ci = componentIndex.byComponentKey.get(componentKey) || null;
    if (ci) {
      sources.components = ci;
      candidates.push({ source: "components", qty: ci });
    }
    const cb = batchIndex.byComponentKey.get(componentKey) || null;
    if (cb) {
      sources.batches = cb;
      candidates.push({ source: "batches", qty: cb });
    }
  } else if (itemKey) {
    const ci2 = componentIndex.byItemKey.get(itemKey) || null;
    if (ci2) {
      sources.components = ci2;
      candidates.push({
        source: "components",
        qty: ci2,
        note: "matched_component_by_itemKey",
      });
    }
    const cb2 = batchIndex.byItemKey.get(itemKey) || null;
    if (cb2) {
      sources.batches = cb2;
      candidates.push({
        source: "batches",
        qty: cb2,
        note: "matched_batch_by_itemKey",
      });
    }
  }

  // Sum candidates when possible (same unit); else use max as conservative signal.
  let onHand = null;
  let unitMismatch = false;

  if (!candidates.length) {
    onHand = targetQty
      ? { value: 0, unit: targetQty.unit }
      : { value: 0, unit: "unit" };
    return { onHandQty: onHand, sources, notes, unitMismatch: false };
  }

  for (const c of candidates) {
    if (!c.qty) continue;
    if (!onHand) {
      onHand = c.qty;
      continue;
    }
    const added = addQty(onHand, c.qty);
    if (added) {
      onHand = added;
    } else {
      // Try conversion if available and target unit exists
      if (convert && targetQty) {
        const converted = convert(c.qty, targetQty.unit);
        if (converted && normalizeQty(converted)?.unit === targetQty.unit) {
          const added2 = addQty(onHand, converted);
          if (added2) {
            onHand = added2;
            notes.push(`converted_${c.source}_to_${targetQty.unit}`);
            continue;
          }
        }
      }
      unitMismatch = true;
      onHand = maxQty(onHand, c.qty); // stable fallback
    }
  }

  if (unitMismatch) {
    notes.push("unit_mismatch_detected");
  }

  return { onHandQty: onHand, sources, notes, unitMismatch };
}

function suggestActions({ line, options }) {
  const actions = [];

  const gap = normalizeQty(line.gapQty);
  if (!gap || gap.value <= 0) return actions;

  const itemKey = safeStr(line.itemKey, "");
  const componentKey = safeStr(line.componentKey, "");

  // Policy knobs
  const minBatchThreshold = safeNum(options?.minBatchThreshold, 0);
  const allowCookAction = options?.allowCookAction !== false;
  const allowBuyAction = options?.allowBuyAction !== false;
  const allowPreserveAction = options?.allowPreserveAction !== false;
  const allowGardenAction = options?.allowGardenAction !== false;
  const allowAnimalsAction = options?.allowAnimalsAction !== false;

  // Deterministic action ordering:
  // 1) Use components/batches if componentKey present and cook allowed
  // 2) Preserve (if shelf-stable and preserve allowed)
  // 3) Garden/Animals suggestions (if enabled and item suggests it)
  // 4) Buy fallback
  //
  // NOTE: if you later add method maps, you can replace heuristics with catalog rules.

  const isLarge = gap.value >= minBatchThreshold && minBatchThreshold > 0;

  if (componentKey && allowCookAction) {
    actions.push({
      id: `action:cook:${componentKey}:${gap.unit}:${gap.value}`,
      kind: "cook",
      componentKey,
      itemKey: itemKey || null,
      qty: gap,
      priority: line.priority || "normal",
      reason: isLarge
        ? "gap_large_batch_recommended"
        : "gap_component_available",
    });
  }

  // Simple preserve heuristic: if tags include preservation-friendly, or unit suggests bulk
  if (allowPreserveAction) {
    const tags = new Set([...(line.tags || [])].map(String));
    const preservationFriendly =
      tags.has("preserve.friendly") ||
      tags.has("freezer.friendly") ||
      tags.has("can.friendly");
    if (preservationFriendly || isLarge) {
      actions.push({
        id: `action:preserve:${itemKey || componentKey}:${gap.unit}:${gap.value}`,
        kind: "preserve",
        itemKey: itemKey || null,
        componentKey: componentKey || null,
        qty: gap,
        priority: line.priority || "normal",
        reason: preservationFriendly
          ? "preservation_tagged"
          : "gap_large_preserve_recommended",
      });
    }
  }

  // Garden/Animals heuristics based on itemKey tokens
  const key = (itemKey || componentKey).toLowerCase();
  if (allowGardenAction) {
    const gardenish =
      key.includes("tomato") ||
      key.includes("onion") ||
      key.includes("pepper") ||
      key.includes("greens") ||
      key.includes("okra") ||
      key.includes("herb") ||
      key.includes("lettuce") ||
      key.includes("carrot");
    if (gardenish) {
      actions.push({
        id: `action:garden:${itemKey || componentKey}`,
        kind: "garden",
        itemKey: itemKey || null,
        componentKey: componentKey || null,
        qty: gap,
        priority: line.priority || "normal",
        reason: "item_suggests_garden_production",
      });
    }
  }

  if (allowAnimalsAction) {
    const animalish =
      key.includes("egg") ||
      key.includes("chicken") ||
      key.includes("goat") ||
      key.includes("beef") ||
      key.includes("lamb") ||
      key.includes("milk") ||
      key.includes("broth");
    if (animalish) {
      actions.push({
        id: `action:animals:${itemKey || componentKey}`,
        kind: "animals",
        itemKey: itemKey || null,
        componentKey: componentKey || null,
        qty: gap,
        priority: line.priority || "normal",
        reason: "item_suggests_animal_production",
      });
    }
  }

  if (allowBuyAction) {
    actions.push({
      id: `action:buy:${itemKey || componentKey}:${gap.unit}:${gap.value}`,
      kind: "buy",
      itemKey: itemKey || null,
      componentKey: componentKey || null,
      qty: gap,
      priority: line.priority || "normal",
      reason: "buy_to_fill_gap",
    });
  }

  return actions;
}

/* -------------------------------------------------------------------------- */
/* Public API */
/* -------------------------------------------------------------------------- */

/**
 * Main entry: check gaps for a targets doc or a targetsId from DB.
 *
 * @param {object} args
 * @param {string} args.householdId
 * @param {object=} args.targets  Targets doc (preferred if already computed)
 * @param {string=} args.targetsId Optional: load from ftt_provisioning_targets
 * @param {object=} args.options  Policy/config hooks
 */
export async function checkGaps({
  householdId,
  targets = null,
  targetsId = null,
  options = {},
} = {}) {
  const hId = safeStr(householdId).trim();
  if (!hId) throw new Error("[GapChecker] householdId is required");

  // Load targets
  const targetsDoc =
    targets && typeof targets === "object"
      ? targets
      : await loadTargetsFromDb({ targetsId });

  const normalizedTargets = normalizeTargetsDoc(targetsDoc, hId);

  // Load sources (local-first)
  const [inventoryRows, storehouseRows, componentRows, batchRows] =
    await Promise.all([
      loadInventoryByHousehold(hId),
      loadStorehouseByHousehold(hId),
      loadComponentInventory(hId),
      loadComponentBatches(hId, { sinceISO: options?.batchesSinceISO || null }),
    ]);

  const inventoryIndex = indexInventory(inventoryRows);
  const storehouseIndex = indexStorehouse(storehouseRows);
  const componentIndex = indexComponentInventory(componentRows);
  const batchIndex = indexBatches(batchRows, {
    includeStatuses: options?.includeBatchStatuses || ["completed"],
  });

  const lines = [];
  const flattenedActions = [];

  let considered = 0;
  for (const tLine of normalizedTargets.items) {
    const targetQty = normalizeQty(tLine.qty);
    if (!targetQty) continue;

    considered += 1;

    const { onHandQty, sources, notes, unitMismatch } = computeOnHand({
      targetLine: tLine,
      inventoryIndex,
      storehouseIndex,
      componentIndex,
      batchIndex,
      options,
    });

    let gapQty = null;
    let coveragePct = 0;

    const diff = subQty(targetQty, onHandQty);
    if (diff) {
      gapQty = { value: Math.max(0, diff.value), unit: diff.unit };
      coveragePct = pct(targetQty.value - gapQty.value, targetQty.value);
    } else {
      // unit mismatch or missing units prevents arithmetic
      gapQty = { value: targetQty.value, unit: targetQty.unit };
      coveragePct = 0;
      if (unitMismatch) notes.push("cannot_compute_gap_due_to_unit_mismatch");
      else notes.push("cannot_compute_gap");
    }

    const line = {
      itemKey: tLine.itemKey || null,
      componentKey: tLine.componentKey || null,
      kind: tLine.kind,
      priority: tLine.priority,
      title: tLine.title || null,
      tags: tLine.tags || [],
      meta: tLine.meta || {},

      targetQty,
      onHandQty,
      gapQty,

      coveragePct,
      confidence: unitMismatch ? 0.55 : 0.85,

      sources,
      notes,
    };

    const suggestedActions = suggestActions({ line, options });
    line.suggestedActions = suggestedActions;

    lines.push(line);
    flattenedActions.push(...suggestedActions);
  }

  // Deduplicate actions (stable key: kind + itemKey/componentKey + unit)
  const actions = uniqBy(
    flattenedActions,
    (a) =>
      a.id ||
      `${a.kind}:${a.itemKey || ""}:${a.componentKey || ""}:${a.qty?.unit}`,
  );

  // Filter: only keep actions above min gap threshold if specified
  const minGapValue = safeNum(options?.minGapValue, 0);
  const actionsFiltered =
    minGapValue > 0
      ? actions.filter((a) => safeNum(a.qty?.value, 0) >= minGapValue)
      : actions;

  // Sort: priority first, then kind ordering
  const priorityRank = (p) => {
    const v = safeStr(p, "normal").toLowerCase();
    if (v === "critical") return 0;
    if (v === "high") return 1;
    if (v === "normal") return 2;
    if (v === "low") return 3;
    return 4;
  };
  const kindRank = (k) => {
    const v = safeStr(k, "").toLowerCase();
    if (v === "cook") return 0;
    if (v === "preserve") return 1;
    if (v === "garden") return 2;
    if (v === "animals") return 3;
    if (v === "buy") return 4;
    return 9;
  };

  actionsFiltered.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const kr = kindRank(a.kind) - kindRank(b.kind);
    if (kr !== 0) return kr;
    return safeStr(a.id).localeCompare(safeStr(b.id));
  });

  // Sort lines: biggest gap first (by raw value), then priority
  lines.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const gv = safeNum(b.gapQty?.value, 0) - safeNum(a.gapQty?.value, 0);
    if (gv !== 0) return gv;
    return safeStr(a.itemKey || a.componentKey).localeCompare(
      safeStr(b.itemKey || b.componentKey),
    );
  });

  const totals = {
    targetLines: normalizedTargets.items.length,
    consideredLines: considered,
    gaps: lines.filter((l) => safeNum(l.gapQty?.value, 0) > 0).length,
  };

  const result = {
    householdId: hId,
    targetsId: normalizedTargets.id || targetsId || null,
    window: normalizedTargets.window,
    computedAt: nowIso(),
    totals,
    lines,
    actions: actionsFiltered,
    debug: {
      inventoryRows: inventoryRows.length,
      storehouseRows: storehouseRows.length,
      componentInventoryRows: componentRows.length,
      componentBatchRows: batchRows.length,
      options: deepClone(options || {}),
    },
  };

  return result;
}

/**
 * Convenience: compute gaps and persist a snapshot line-items record into ftt_plan_items if desired.
 *
 * @param {object} args
 * @param {string} args.planId
 * @param {string} args.householdId
 * @param {object=} args.targets
 * @param {string=} args.targetsId
 * @param {object=} args.options
 */
export async function checkGapsAndWritePlanItems({
  planId,
  householdId,
  targets = null,
  targetsId = null,
  options = {},
} = {}) {
  const res = await checkGaps({ householdId, targets, targetsId, options });

  if (!planId) return { ...res, wrotePlanItems: false, wroteCount: 0 };
  if (!hasTable("ftt_plan_items"))
    return { ...res, wrotePlanItems: false, wroteCount: 0 };

  const now = nowIso();
  const pid = safeStr(planId);

  // Write one plan item per gap line (only gap > 0)
  const planItems = res.lines
    .filter((l) => safeNum(l.gapQty?.value, 0) > 0)
    .map((l) => ({
      id: `planItem:gap:${pid}:${l.itemKey || l.componentKey}:${l.gapQty.unit}:${Math.round(l.gapQty.value * 1000)}`,
      planId: pid,
      householdId: safeStr(householdId),
      kind: "gap",
      itemKey: l.itemKey || null,
      componentKey: l.componentKey || null,
      status: "open",
      createdAt: now,
      updatedAt: now,
      qty: l.gapQty,
      targetQty: l.targetQty,
      onHandQty: l.onHandQty,
      coveragePct: l.coveragePct,
      suggestedActions: l.suggestedActions,
      notes: l.notes,
      meta: {
        priority: l.priority,
        sources: l.sources,
      },
    }));

  try {
    await db.transaction("rw", db.ftt_plan_items, async () => {
      await db.ftt_plan_items.bulkPut(planItems);
    });
    return { ...res, wrotePlanItems: true, wroteCount: planItems.length };
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[GapChecker] failed to write plan items", e);
    // fallback sequential
    let wrote = 0;
    for (const it of planItems) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await db.ftt_plan_items
        .put(it)
        .then(() => true)
        .catch(() => false);
      if (ok) wrote += 1;
    }
    return { ...res, wrotePlanItems: wrote > 0, wroteCount: wrote };
  }
}

/* -------------------------------------------------------------------------- */
/* Default export */
/* -------------------------------------------------------------------------- */

const GapChecker = {
  checkGaps,
  checkGapsAndWritePlanItems,
};

export default GapChecker;
