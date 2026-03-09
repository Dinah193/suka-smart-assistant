/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\SourcingResolver.js
//
// SourcingResolver (FTT)
// ----------------------
// Purpose
// - Given a set of provisioning "needs" (targets or gaps), choose a preferred
//   sourcing plan per line: use on-hand, cook from components, preserve from
//   existing surplus, garden/animals production, or buy.
//
// Design goals
// - Deterministic, non-AI, local-first
// - Safe when optional tables/services are missing
// - Pluggable policies via options (ranking + enable/disable channels)
//
// Inputs
// - householdId (required)
// - lines: array of needs, each should include at minimum:
//   { itemKey?, componentKey?, qty:{value,unit}, priority?, tags?, meta? }
//   (This can be "targets", "gaps", or your GapChecker output lines)
//
// Optional context
// - inventory/storehouse/component inventory/batches read from db
// - optional conversion hook: options.convert(fromQty, toUnit) -> qty
//
// Output
// - {
//     householdId,
//     computedAt,
//     window,
//     lines:[
//       {
//         ...input,
//         resolved: {
//           strategy: "use_on_hand"|"cook"|"preserve"|"garden"|"animals"|"buy"|"unknown",
//           confidence,
//           allocations:[ {source, qty, refs?, notes?} ],
//           remainingQty, // after allocations
//           recommendedActions:[ ... ],
//           notes:[ ... ],
//         }
//       }
//     ],
//     actions:[ ... flattened ... ],
//     debug:{ ... }
//   }
//
// Notes
// - This resolver does not require GapChecker, but pairs well with it.
// - If you provide GapChecker lines, it will prefer using the precomputed
//   onHandQty and gapQty to avoid redundant reads.
// - "Preserve" is treated as an action suggestion unless you have explicit
//   preservation stock tables beyond storehouse/inventory. If you later add
//   preservation_outputs_index or a dedicated preserved_items table, you can
//   hook it in via options.loadPreserved().

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

function toDayKey(iso) {
  return safeStr(iso, nowIso()).slice(0, 10);
}

function normalizeQty(qty) {
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

function minQty(a, b) {
  const qa = normalizeQty(a);
  const qb = normalizeQty(b);
  if (!qa) return qb;
  if (!qb) return qa;
  if (qa.unit !== qb.unit) return qa;
  return qa.value <= qb.value ? qa : qb;
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

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function normalizeNeedLine(line) {
  const l = line && typeof line === "object" ? line : {};
  const qty =
    normalizeQty(l.gapQty) ||
    normalizeQty(l.qty) ||
    normalizeQty(l.amount) ||
    normalizeQty(l.quantity);

  return {
    itemKey: safeStr(l.itemKey || l.item || l.sku, "").trim() || null,
    componentKey: safeStr(l.componentKey || l.component, "").trim() || null,
    qty,
    // optional precomputed on-hand info (GapChecker style)
    onHandQty: normalizeQty(l.onHandQty) || null,
    targetQty: normalizeQty(l.targetQty) || null,
    gapQty: normalizeQty(l.gapQty) || null,
    coveragePct: safeNum(l.coveragePct, null),

    priority: safeStr(l.priority || "normal"),
    tags: Array.isArray(l.tags) ? l.tags.map(String).filter(Boolean) : [],
    title: safeStr(l.title || "", "") || null,
    kind: safeStr(l.kind || "need"),
    meta: l.meta && typeof l.meta === "object" ? l.meta : {},
    sources: l.sources && typeof l.sources === "object" ? l.sources : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Loaders + Indexers */
/* -------------------------------------------------------------------------- */

async function loadInventory() {
  if (!hasTable("inventory")) return [];
  try {
    return await db.inventory.toArray();
  } catch {
    return [];
  }
}

async function loadStorehouse() {
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

function indexInventory(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const sku = safeStr(r.sku || r.itemKey || r.key, "").trim();
    const name = safeStr(r.name || "", "").trim();
    const qty = normalizeQty({ value: r.quantity, unit: r.unit });
    if (!qty) continue;

    if (sku) {
      const prev = byKey.get(sku);
      byKey.set(sku, prev ? addQty(prev, qty) || prev : qty);
    }
    if (name) {
      const k = `name:${name.toLowerCase()}`;
      const prev = byKey.get(k);
      byKey.set(k, prev ? addQty(prev, qty) || prev : qty);
    }
  }
  return { byKey };
}

function indexStorehouse(rows) {
  const byItemKey = new Map();
  for (const r of rows || []) {
    const itemKey = safeStr(r.itemKey || r.sku || r.name, "").trim();
    if (!itemKey) continue;

    const qty = normalizeQty({
      value: r.actualQuantity ?? r.plannedQuantity,
      unit: r.unit || "unit",
    });
    if (!qty) continue;

    const prev = byItemKey.get(itemKey);
    byItemKey.set(itemKey, prev ? addQty(prev, qty) || prev : qty);
  }
  return { byItemKey };
}

function indexComponentInventory(rows) {
  const byComponentKey = new Map();
  const byItemKey = new Map();

  for (const r of rows || []) {
    const componentKey = safeStr(r.componentKey || r.component, "").trim();
    const itemKey = safeStr(r.itemKey || r.item, "").trim();
    const qty = normalizeQty(r.qty || r.amount || r.quantity);
    if (!qty) continue;

    if (componentKey) {
      const prev = byComponentKey.get(componentKey);
      byComponentKey.set(componentKey, prev ? addQty(prev, qty) || prev : qty);
    }
    if (itemKey) {
      const prev = byItemKey.get(itemKey);
      byItemKey.set(itemKey, prev ? addQty(prev, qty) || prev : qty);
    }
  }

  return { byComponentKey, byItemKey };
}

function indexBatches(rows, { includeStatuses = ["completed"] } = {}) {
  const include = new Set(includeStatuses.map(String));
  const byComponentKey = new Map();
  const byItemKey = new Map();

  for (const b of rows || []) {
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
      if (!qty) continue;

      if (componentKey) {
        const prev = byComponentKey.get(componentKey);
        byComponentKey.set(
          componentKey,
          prev ? addQty(prev, qty) || prev : qty,
        );
      }
      if (itemKey) {
        const prev = byItemKey.get(itemKey);
        byItemKey.set(itemKey, prev ? addQty(prev, qty) || prev : qty);
      }
    }
  }

  return { byComponentKey, byItemKey };
}

/* -------------------------------------------------------------------------- */
/* Strategy scoring / policy */
/* -------------------------------------------------------------------------- */

const DEFAULT_KIND_ORDER = [
  "use_on_hand",
  "cook",
  "preserve",
  "garden",
  "animals",
  "buy",
  "unknown",
];

function priorityRank(priority) {
  const p = safeStr(priority, "normal").toLowerCase();
  if (p === "critical") return 0;
  if (p === "high") return 1;
  if (p === "normal") return 2;
  if (p === "low") return 3;
  return 4;
}

function kindRank(kind, order) {
  const k = safeStr(kind, "unknown");
  const idx = order.indexOf(k);
  return idx >= 0 ? idx : order.length + 1;
}

function isGardenish(itemKeyOrComponentKey) {
  const key = safeStr(itemKeyOrComponentKey, "").toLowerCase();
  return (
    key.includes("tomato") ||
    key.includes("onion") ||
    key.includes("pepper") ||
    key.includes("greens") ||
    key.includes("okra") ||
    key.includes("herb") ||
    key.includes("lettuce") ||
    key.includes("carrot") ||
    key.includes("cucumber") ||
    key.includes("squash") ||
    key.includes("bean") ||
    key.includes("pea")
  );
}

function isAnimalish(itemKeyOrComponentKey) {
  const key = safeStr(itemKeyOrComponentKey, "").toLowerCase();
  return (
    key.includes("egg") ||
    key.includes("chicken") ||
    key.includes("goat") ||
    key.includes("beef") ||
    key.includes("lamb") ||
    key.includes("milk") ||
    key.includes("broth") ||
    key.includes("turkey") ||
    key.includes("fish")
  );
}

function hasPreserveTag(tags) {
  const set = new Set((tags || []).map((t) => String(t)));
  return (
    set.has("preserve.friendly") ||
    set.has("freezer.friendly") ||
    set.has("can.friendly") ||
    set.has("dehydrate.friendly") ||
    set.has("ferment.friendly")
  );
}

/* -------------------------------------------------------------------------- */
/* Allocation helpers */
/* -------------------------------------------------------------------------- */

function allocateUpTo(neededQty, availableQty) {
  const need = normalizeQty(neededQty);
  const avail = normalizeQty(availableQty);
  if (!need || !avail) return { allocated: null, remaining: need };
  if (need.unit !== avail.unit) return { allocated: null, remaining: need };

  const allocatedValue = Math.max(0, Math.min(need.value, avail.value));
  const allocated = { value: allocatedValue, unit: need.unit };
  const remaining = {
    value: Math.max(0, need.value - allocatedValue),
    unit: need.unit,
  };
  return { allocated, remaining };
}

function makeActionId(prefix, parts) {
  const safe = parts
    .map((p) => safeStr(p, "").replace(/\s+/g, "_"))
    .filter(Boolean);
  return `${prefix}:${safe.join(":")}`;
}

/* -------------------------------------------------------------------------- */
/* Core resolver */
/* -------------------------------------------------------------------------- */

function computeAvailableForLine({
  line,
  invIndex,
  shIndex,
  ciIndex,
  bIndex,
  options,
}) {
  // Returns availability candidates (qty) per source, attempting unit conversion if provided.
  const convert =
    options?.convert && typeof options.convert === "function"
      ? options.convert
      : null;

  const needQty = normalizeQty(line.qty);
  const itemKey = line.itemKey;
  const componentKey = line.componentKey;

  const candidates = [];

  // If the line already includes sources/onHandQty from GapChecker, treat that as "available"
  // but still populate per-source breakdown if possible.
  if (line.sources && typeof line.sources === "object") {
    // best effort: convert to unit if needed
    for (const [src, q] of Object.entries(line.sources)) {
      const qq = normalizeQty(q);
      if (!qq) continue;
      let qUnit = qq;
      if (needQty && qq.unit !== needQty.unit && convert) {
        const converted = convert(qq, needQty.unit);
        const c = normalizeQty(converted);
        if (c) qUnit = c;
      }
      candidates.push({
        source: src,
        qty: qUnit,
        refs: { via: "precomputed_sources" },
      });
    }
  }

  // Inventory: by sku or name
  if (itemKey) {
    const inv =
      invIndex.byKey.get(itemKey) ||
      invIndex.byKey.get(`name:${itemKey.toLowerCase()}`) ||
      null;
    if (inv) {
      let qty = inv;
      if (needQty && inv.unit !== needQty.unit && convert) {
        const converted = convert(inv, needQty.unit);
        const c = normalizeQty(converted);
        if (c) qty = c;
      }
      candidates.push({
        source: "inventory",
        qty,
        refs: { skuOrName: itemKey },
      });
    }
  }

  // Storehouse
  if (itemKey) {
    const sh = shIndex.byItemKey.get(itemKey) || null;
    if (sh) {
      let qty = sh;
      if (needQty && sh.unit !== needQty.unit && convert) {
        const converted = convert(sh, needQty.unit);
        const c = normalizeQty(converted);
        if (c) qty = c;
      }
      candidates.push({ source: "storehouse", qty, refs: { itemKey } });
    }
  }

  // Component inventory + batches
  if (componentKey) {
    const ci = ciIndex.byComponentKey.get(componentKey) || null;
    if (ci) {
      let qty = ci;
      if (needQty && ci.unit !== needQty.unit && convert) {
        const converted = convert(ci, needQty.unit);
        const c = normalizeQty(converted);
        if (c) qty = c;
      }
      candidates.push({ source: "components", qty, refs: { componentKey } });
    }

    const cb = bIndex.byComponentKey.get(componentKey) || null;
    if (cb) {
      let qty = cb;
      if (needQty && cb.unit !== needQty.unit && convert) {
        const converted = convert(cb, needQty.unit);
        const c = normalizeQty(converted);
        if (c) qty = c;
      }
      candidates.push({ source: "batches", qty, refs: { componentKey } });
    }
  } else if (itemKey) {
    const ci2 = ciIndex.byItemKey.get(itemKey) || null;
    if (ci2) {
      let qty = ci2;
      if (needQty && ci2.unit !== needQty.unit && convert) {
        const converted = convert(ci2, needQty.unit);
        const c = normalizeQty(converted);
        if (c) qty = c;
      }
      candidates.push({
        source: "components",
        qty,
        refs: { itemKey, note: "matched_component_by_itemKey" },
      });
    }

    const cb2 = bIndex.byItemKey.get(itemKey) || null;
    if (cb2) {
      let qty = cb2;
      if (needQty && cb2.unit !== needQty.unit && convert) {
        const converted = convert(cb2, needQty.unit);
        const c = normalizeQty(converted);
        if (c) qty = c;
      }
      candidates.push({
        source: "batches",
        qty,
        refs: { itemKey, note: "matched_batch_by_itemKey" },
      });
    }
  }

  // Deduplicate by source (keep max qty per source)
  const bySource = new Map();
  for (const c of candidates) {
    const q = normalizeQty(c.qty);
    if (!q) continue;
    const prev = bySource.get(c.source);
    if (!prev) {
      bySource.set(c.source, { ...c, qty: q });
      continue;
    }
    if (prev.qty.unit === q.unit && q.value > prev.qty.value) {
      bySource.set(c.source, { ...c, qty: q });
    }
  }

  return Array.from(bySource.values());
}

function resolveLineStrategy({ line, availability, options }) {
  const kindOrder = Array.isArray(options?.kindOrder)
    ? options.kindOrder
    : DEFAULT_KIND_ORDER;

  const enabled = {
    use_on_hand: options?.enableUseOnHand !== false,
    cook: options?.enableCook !== false,
    preserve: options?.enablePreserve !== false,
    garden: options?.enableGarden !== false,
    animals: options?.enableAnimals !== false,
    buy: options?.enableBuy !== false,
  };

  const needQty = normalizeQty(line.qty);
  const notes = [];
  const allocations = [];
  const recommendedActions = [];

  if (!needQty) {
    return {
      strategy: "unknown",
      confidence: 0.2,
      allocations: [],
      remainingQty: null,
      recommendedActions: [],
      notes: ["missing_qty"],
    };
  }

  // Build a simple "available on hand" number from availability sources
  const usableSources = ["inventory", "storehouse", "components", "batches"];
  let onHand = null;
  for (const src of usableSources) {
    const a = availability.find((x) => x.source === src);
    if (!a) continue;
    if (!onHand) {
      onHand = a.qty;
    } else {
      const sum = addQty(onHand, a.qty);
      if (sum) onHand = sum;
      else notes.push(`unit_mismatch_${src}`);
    }
  }
  if (!onHand) onHand = { value: 0, unit: needQty.unit };

  // 1) Allocate from on-hand (inventory/storehouse/components/batches) first, if enabled
  let remaining = needQty;
  if (enabled.use_on_hand) {
    // deterministic allocation order among on-hand sources:
    const allocationOrder = Array.isArray(options?.onHandAllocationOrder)
      ? options.onHandAllocationOrder
      : ["batches", "components", "storehouse", "inventory"];

    for (const src of allocationOrder) {
      const a = availability.find((x) => x.source === src);
      if (!a || !a.qty) continue;

      const { allocated, remaining: rem } = allocateUpTo(remaining, a.qty);
      if (allocated && allocated.value > 0) {
        allocations.push({
          source: src,
          qty: allocated,
          refs: a.refs || null,
          notes: a.note ? [a.note] : [],
        });
        remaining = rem;
      }
      if (remaining.value <= 0) break;
    }

    if (remaining.value <= 0) {
      return {
        strategy: "use_on_hand",
        confidence: 0.9,
        allocations,
        remainingQty: { value: 0, unit: needQty.unit },
        recommendedActions,
        notes,
      };
    }
  }

  // 2) Decide additional strategy for remainder
  const token = (line.itemKey || line.componentKey || "").toLowerCase();
  const gardenish = enabled.garden && isGardenish(token);
  const animalish = enabled.animals && isAnimalish(token);
  const preserveish =
    enabled.preserve &&
    (hasPreserveTag(line.tags) ||
      remaining.value >= safeNum(options?.preserveThresholdValue, Infinity));

  // Strategy candidates for remainder (scored)
  const candidates = [];

  if (enabled.cook && line.componentKey) {
    candidates.push({
      kind: "cook",
      score: 90,
      reason: "componentKey_present",
    });
  }

  if (preserveish) {
    candidates.push({
      kind: "preserve",
      score: 75,
      reason: hasPreserveTag(line.tags) ? "preserve_tagged" : "remainder_large",
    });
  }

  if (gardenish) {
    candidates.push({
      kind: "garden",
      score: 60,
      reason: "item_suggests_garden",
    });
  }

  if (animalish) {
    candidates.push({
      kind: "animals",
      score: 55,
      reason: "item_suggests_animals",
    });
  }

  if (enabled.buy) {
    candidates.push({
      kind: "buy",
      score: 50,
      reason: "buy_fallback",
    });
  }

  if (!candidates.length) {
    candidates.push({
      kind: "unknown",
      score: 1,
      reason: "no_enabled_channels",
    });
  }

  // Order candidates by: kind order first, then score
  candidates.sort((a, b) => {
    const kr = kindRank(a.kind, kindOrder) - kindRank(b.kind, kindOrder);
    if (kr !== 0) return kr;
    return b.score - a.score;
  });

  const chosen = candidates[0];
  const chosenKind = chosen?.kind || "unknown";

  // Create recommended action for remainder
  const baseKey = line.itemKey || line.componentKey || "unknown";
  const actionQty = remaining;

  if (chosenKind === "cook") {
    recommendedActions.push({
      id: makeActionId("action:cook", [
        line.componentKey || baseKey,
        actionQty.unit,
        actionQty.value,
      ]),
      kind: "cook",
      componentKey: line.componentKey,
      itemKey: line.itemKey || null,
      qty: actionQty,
      priority: line.priority,
      reason: chosen.reason,
    });
  } else if (chosenKind === "preserve") {
    recommendedActions.push({
      id: makeActionId("action:preserve", [
        baseKey,
        actionQty.unit,
        actionQty.value,
      ]),
      kind: "preserve",
      itemKey: line.itemKey || null,
      componentKey: line.componentKey || null,
      qty: actionQty,
      priority: line.priority,
      reason: chosen.reason,
    });
  } else if (chosenKind === "garden") {
    recommendedActions.push({
      id: makeActionId("action:garden", [baseKey]),
      kind: "garden",
      itemKey: line.itemKey || null,
      componentKey: line.componentKey || null,
      qty: actionQty,
      priority: line.priority,
      reason: chosen.reason,
    });
  } else if (chosenKind === "animals") {
    recommendedActions.push({
      id: makeActionId("action:animals", [baseKey]),
      kind: "animals",
      itemKey: line.itemKey || null,
      componentKey: line.componentKey || null,
      qty: actionQty,
      priority: line.priority,
      reason: chosen.reason,
    });
  } else if (chosenKind === "buy") {
    recommendedActions.push({
      id: makeActionId("action:buy", [
        baseKey,
        actionQty.unit,
        actionQty.value,
      ]),
      kind: "buy",
      itemKey: line.itemKey || null,
      componentKey: line.componentKey || null,
      qty: actionQty,
      priority: line.priority,
      reason: chosen.reason,
    });
  } else {
    recommendedActions.push({
      id: makeActionId("action:unknown", [baseKey]),
      kind: "unknown",
      itemKey: line.itemKey || null,
      componentKey: line.componentKey || null,
      qty: actionQty,
      priority: line.priority,
      reason: chosen.reason,
    });
  }

  const confidenceBase =
    chosenKind === "cook"
      ? 0.85
      : chosenKind === "preserve"
        ? 0.7
        : chosenKind === "garden"
          ? 0.6
          : chosenKind === "animals"
            ? 0.6
            : chosenKind === "buy"
              ? 0.75
              : 0.25;

  const usedOnHandValue =
    safeNum(needQty.value, 0) - safeNum(remaining.value, 0);
  const coverage = pct(usedOnHandValue, needQty.value);

  // Confidence up if we covered a chunk on-hand
  const confidence = clamp(
    confidenceBase + (coverage >= 50 ? 0.08 : coverage >= 20 ? 0.04 : 0),
    0.1,
    0.95,
  );

  // Add notes
  if (chosen?.reason) notes.push(`strategy_reason:${chosen.reason}`);
  notes.push(`coverage:${Math.round(coverage)}pct`);

  return {
    strategy: chosenKind,
    confidence,
    allocations,
    remainingQty: remaining,
    recommendedActions,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API */
/* -------------------------------------------------------------------------- */

/**
 * Resolve sourcing for a set of needs/gaps/targets.
 *
 * @param {object} args
 * @param {string} args.householdId
 * @param {Array<object>} args.lines
 * @param {object=} args.window {startISO,horizonDays}
 * @param {object=} args.options policy knobs
 */
export async function resolveSourcing({
  householdId,
  lines = [],
  window = null,
  options = {},
} = {}) {
  const hId = safeStr(householdId).trim();
  if (!hId) throw new Error("[SourcingResolver] householdId is required");
  if (!Array.isArray(lines))
    throw new Error("[SourcingResolver] lines must be an array");

  // Load sources once (unless caller opts out)
  const useDbContext = options?.useDbContext !== false;

  const [invRows, shRows, ciRows, bRows] = useDbContext
    ? await Promise.all([
        loadInventory(),
        loadStorehouse(),
        loadComponentInventory(hId),
        loadComponentBatches(hId, {
          sinceISO: options?.batchesSinceISO || null,
        }),
      ])
    : [[], [], [], []];

  const invIndex = indexInventory(invRows);
  const shIndex = indexStorehouse(shRows);
  const ciIndex = indexComponentInventory(ciRows);
  const bIndex = indexBatches(bRows, {
    includeStatuses: options?.includeBatchStatuses || ["completed"],
  });

  // Normalize input lines
  const normalized = lines
    .map(normalizeNeedLine)
    .filter((l) => l.qty && (l.itemKey || l.componentKey));

  // Sort deterministically: priority then largest qty
  normalized.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return safeNum(b.qty?.value, 0) - safeNum(a.qty?.value, 0);
  });

  const resolvedLines = [];
  const allActions = [];

  for (const line of normalized) {
    const availability = computeAvailableForLine({
      line,
      invIndex,
      shIndex,
      ciIndex,
      bIndex,
      options,
    });

    const resolved = resolveLineStrategy({ line, availability, options });

    const out = {
      ...line,
      resolved: {
        ...resolved,
        allocations: resolved.allocations || [],
        remainingQty: resolved.remainingQty || {
          value: 0,
          unit: normalizeQty(line.qty)?.unit || "unit",
        },
      },
      availability, // helpful for UI explainers
    };

    resolvedLines.push(out);
    allActions.push(...(resolved.recommendedActions || []));
  }

  // Dedup actions
  const actions = uniqBy(
    allActions,
    (a) =>
      a.id ||
      `${a.kind}:${a.itemKey || ""}:${a.componentKey || ""}:${a.qty?.unit}:${a.qty?.value}`,
  );

  // Stable sort actions
  const kindOrder = Array.isArray(options?.kindOrder)
    ? options.kindOrder
    : DEFAULT_KIND_ORDER;
  actions.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const kr = kindRank(a.kind, kindOrder) - kindRank(b.kind, kindOrder);
    if (kr !== 0) return kr;
    return safeStr(a.id).localeCompare(safeStr(b.id));
  });

  return {
    householdId: hId,
    computedAt: nowIso(),
    window:
      window && typeof window === "object"
        ? {
            startISO: safeStr(window.startISO || nowIso()),
            horizonDays: clamp(window.horizonDays ?? 14, 1, 365),
          }
        : null,
    lines: resolvedLines,
    actions,
    debug: {
      useDbContext,
      counts: {
        inputLines: lines.length,
        normalizedLines: normalized.length,
        resolvedLines: resolvedLines.length,
        actions: actions.length,
        invRows: invRows.length,
        shRows: shRows.length,
        ciRows: ciRows.length,
        bRows: bRows.length,
      },
      options: deepClone(options || {}),
    },
  };
}

/**
 * Convenience: resolve sourcing for GapChecker output.
 * Accepts GapChecker result and uses its lines.
 */
export async function resolveSourcingFromGapCheck({
  householdId,
  gapCheckResult,
  options = {},
} = {}) {
  const hId = safeStr(householdId).trim();
  if (!hId) throw new Error("[SourcingResolver] householdId is required");
  if (!gapCheckResult || typeof gapCheckResult !== "object") {
    throw new Error("[SourcingResolver] gapCheckResult must be an object");
  }

  const gapLines = Array.isArray(gapCheckResult.lines)
    ? gapCheckResult.lines
    : [];
  const window = gapCheckResult.window || null;

  // Default: only resolve for lines with positive gaps if gapQty exists
  const filtered = gapLines.filter((l) => {
    const g = normalizeQty(l.gapQty);
    if (!g) return true; // if no gapQty, treat as need
    return safeNum(g.value, 0) > 0;
  });

  return resolveSourcing({
    householdId: hId,
    lines: filtered,
    window,
    options,
  });
}

/* -------------------------------------------------------------------------- */
/* Default export */
/* -------------------------------------------------------------------------- */

const SourcingResolver = {
  resolveSourcing,
  resolveSourcingFromGapCheck,
};

export default SourcingResolver;
