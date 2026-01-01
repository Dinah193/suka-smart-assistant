// C:\Users\larho\suka-smart-assistant\src\services\planning\procurementScheduler.js
/**
 * procurementScheduler (Dynamic, audit-friendly)
 * ----------------------------------------------
 * Preferred: plan(req, options?) -> EnhancedProcurementPlanResponse
 * Legacy: scheduleProcurement({ demand, inventory, vendors, opts }) -> compatible subset
 *
 * Features:
 *  - Strategies: cost_first, inventory_first, freshness_first, local_first, balanced
 *  - Constraints: budget, vendor allow/block, in-stock/backorder policy, sabbath-aware delivery windows
 *  - Substitutions: per-item alternates with scoring
 *  - Pricing: coupons, price locks, loyalty multipliers, tax
 *  - Fulfillment: delivery/pickup/mixed, route plan for pickups, cold-chain exposure estimate
 *  - Garden forecast: subtracts homegrown before shopping
 *  - Batching links: buy-by dates aligned to batch sessions (bufferDays)
 *  - Alternates: near-miss choices attached to lines
 *  - Audit trail + warnings (visible drafts)
 */

const dayjs = require("dayjs");

let _uuid;
try {
  _uuid = require("uuid").v4;
} catch {
  _uuid = () => `po_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

const VERSION = "2025-09-07.a";

/* =============================================================================
   Helpers & tables
============================================================================= */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_FMT = "GGGG-[W]WW";

function keyOf(x) {
  return String(x || "").toLowerCase().trim().replace(/\s+/g, "_");
}
function parseQty(n) {
  const x = Number(n);
  return Number.isFinite(x) && x >= 0 ? x : 0;
}
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Very coarse unit equivalences for simple matching */
const UNIT_EQUIV = {
  each_to_egg: 1,
  head_to_lb: 1, // lettuce head ≈ 1 lb (coarse)
  cup_to_quart: 0.25,
  quart_to_cup: 4,
};

function convertQty(qty, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return qty;
  const f = fromUnit.toLowerCase();
  const t = toUnit.toLowerCase();
  const key = `${f}_to_${t}`;
  if (UNIT_EQUIV[key] != null) return qty * UNIT_EQUIV[key];
  return null; // unknown conversion
}

function bestUnitMatch(needUnit, skuUnit) {
  if (!needUnit || !skuUnit) return needUnit === skuUnit;
  if (needUnit === skuUnit) return true;
  const tryConv = convertQty(1, needUnit, skuUnit);
  return tryConv != null;
}

/* =============================================================================
   Time windows / Sabbath awareness
============================================================================= */
function nextAllowedDeliveryDay(fromDate, vendor, sabbathAware) {
  const allowDays = (vendor.deliveryDays || []).map((d) => d.slice(0, 3));
  let d = dayjs(fromDate);
  for (let i = 0; i < 21; i++) {
    const dow = DOW[d.day()];
    const saturday = dow === "Sat";
    const okDay = allowDays.length === 0 || allowDays.includes(dow);
    const okSabbath = sabbathAware ? !saturday : vendor.allowSaturdayDelivery ? true : !saturday;
    if (okDay && okSabbath) return d;
    d = d.add(1, "day");
  }
  return dayjs(fromDate);
}

function computeDeliveryFromOrder(orderDate, vendor, sabbathAware) {
  const base = dayjs(orderDate).add(Number(vendor.leadTimeDays || 0), "day");
  return nextAllowedDeliveryDay(base, vendor, sabbathAware);
}

function computeOrderDateForNeed(needByISO, vendor, sabbathAware) {
  const needBy = dayjs(needByISO);
  const lt = Number(vendor.leadTimeDays || 0);
  let guess = needBy.subtract(lt, "day");
  for (let i = 0; i < 14; i++) {
    const delivery = computeDeliveryFromOrder(guess, vendor, sabbathAware);
    if (!delivery.isAfter(needBy)) return guess;
    guess = guess.subtract(1, "day");
  }
  return guess;
}

function applyCutoff(orderDate, vendor, now = dayjs()) {
  const cutoff = vendor.cutoffHour;
  if (cutoff == null) return orderDate;
  let d = dayjs(orderDate);
  const sameDay = d.isSame(now, "day");
  if (sameDay && now.hour() >= cutoff) d = d.add(1, "day");
  return d;
}

/* =============================================================================
   Normalization
============================================================================= */

function inferPriority(name) {
  const k = keyOf(name);
  if (/(milk|egg|lettuce|spinach|greens|bread)/.test(k)) return "essential";
  if (/(flour|rice|beans|oil|sugar)/.test(k)) return "staple";
  return "staple";
}

/**
 * demand: [{ name, qty, unit, needBy?, priority?, tags? }]
 * gardenForecast: [{ name, unit, qty, date? }] — optional, to subtract
 */
function normalizeDemand(demand = [], opts = {}, gardenForecast = []) {
  const start = opts.startDate ? dayjs(opts.startDate) : dayjs().startOf("week");
  const gf = Array.isArray(gardenForecast) ? gardenForecast : [];
  const byKey = new Map();
  for (const g of gf) {
    const k = keyOf(g.name);
    const arr = byKey.get(k) || [];
    arr.push({ qty: parseQty(g.qty), unit: (g.unit || "").toLowerCase(), date: g.date });
    byKey.set(k, arr);
  }

  return (demand || [])
    .map((x, i) => {
      const needBy = x.needBy || x.date || start.toISOString();
      const priority = x.priority || inferPriority(x.name);
      const key = keyOf(x.name);
      // subtract garden forecast if configured to do so
      let qty = parseQty(x.qty);
      const unit = (x.unit || "").toLowerCase();
      const lots = byKey.get(key) || [];
      for (const lot of lots) {
        let usable = lot.qty;
        if (lot.unit && unit && lot.unit !== unit) {
          const conv = convertQty(lot.qty, lot.unit, unit);
          if (conv != null) usable = conv;
        }
        if (usable <= 0) continue;
        const take = Math.min(qty, usable);
        qty -= take;
        lot.qty -= take;
        if (qty <= 0) break;
      }
      return {
        id: x.id || `d_${i}`,
        name: x.name,
        key,
        qty: Math.max(0, qty),
        unit,
        needBy,
        priority,
        tags: (x.tags || []).map((t) => keyOf(t)),
        raw: x,
      };
    })
    .filter((x) => x.qty > 0);
}

function normalizeInventory(inv = {}) {
  const out = {};
  Object.keys(inv || {}).forEach((k) => {
    const v = inv[k];
    out[keyOf(k)] = {
      qty: parseQty(v.qty),
      unit: (v.unit || "").toLowerCase(),
      min: parseQty(v.min || 0),
      reorderTo: parseQty(v.reorderTo || 0),
    };
  });
  return out;
}

function catalogIndex(vendors = []) {
  const map = new Map();
  const all = [];
  vendors.forEach((v) => {
    (v.catalog || []).forEach((sku) => {
      const key = keyOf(sku.name);
      const entry = {
        vendorId: v.id,
        vendorName: v.name,
        vendor: v,
        sku: sku.sku || `${v.id}:${key}`,
        name: sku.name,
        unit: (sku.unit || "").toLowerCase(),
        packQty: parseQty(sku.packQty || 1),
        price: Number(sku.price || 0),
        tags: (sku.tags || []).map((t) => keyOf(t)),
        inStock: sku.inStock !== false,
        minOrderQty: parseQty(sku.minOrderQty || 0),
        substituteFor: (sku.substituteFor || []).map(keyOf),
        freshnessDays: parseQty(sku.freshnessDays || 0), // optional
        local: !!sku.local,
      };
      all.push(entry);
      const arr = map.get(key) || [];
      arr.push(entry);
      map.set(key, arr);
    });
  });
  // index by substituteFor too
  all.forEach((e) => {
    (e.substituteFor || []).forEach((sub) => {
      const arr = map.get(sub) || [];
      arr.push(e);
      map.set(sub, arr);
    });
  });
  return map;
}

/* =============================================================================
   Strategy scoring & selection
============================================================================= */

function effectiveUnitPrice(sku, locks = [], loyalty = {}) {
  // apply price locks if present (locks apply to specific vendor+sku)
  const lock = locks.find((l) => l.vendorId === sku.vendorId && l.sku === sku.sku && (!l.expiresISO || dayjs().isBefore(dayjs(l.expiresISO))));
  const unitPrice = (lock ? Number(lock.unitPrice) : Number(sku.price)) / Math.max(1, sku.packQty);
  const mult = Number(loyalty[sku.vendorId] || 1);
  return unitPrice / Math.max(0.01, mult); // loyalty multiplier makes effective cheaper
}

function skuScoreForStrategy(strategy, sku, need, locks, loyalty) {
  const price = effectiveUnitPrice(sku, locks, loyalty);
  const localBoost = sku.local ? 0.95 : 1.0; // local cheaper effectively
  const freshness = sku.freshnessDays || 0;
  switch (strategy) {
    case "cost_first":
      return 1 / (price * localBoost + 0.0001);
    case "freshness_first":
      return freshness + 0.01 / (price + 0.0001);
    case "local_first":
      return (sku.local ? 1000 : 0) + 1 / (price + 0.0001);
    case "balanced":
    default: {
      const vendorPref = need._vendorPrefIndex?.get(sku.vendorId) ?? 999;
      return (
        0.6 * (1 / (price + 0.0001)) +
        0.2 * (sku.local ? 1 : 0) +
        0.15 * (freshness / 14) +
        0.05 * (1 / (vendorPref + 1))
      );
    }
  }
}

function chooseSkuForNeed(need, candidates, strategy, opts) {
  if (!candidates || candidates.length === 0) return { chosen: null, alternates: [] };

  let pool = candidates.filter((c) => c.inStock !== false && bestUnitMatch(need.unit, c.unit));

  // kosher vendors policy: if ANY vendor has kosherOnly==true, require kosher items
  const kosherOnlyEnv = (opts.vendors || []).some((v) => v.kosherOnly);
  if (kosherOnlyEnv) pool = pool.filter((c) => c.tags.includes("kosher"));

  // vendor allow/block
  const allow = (opts.constraints?.vendorAllowlist || []).length ? new Set(opts.constraints.vendorAllowlist) : null;
  const block = new Set(opts.constraints?.vendorBlocklist || []);
  pool = pool.filter((c) => (allow ? allow.has(c.vendorId) : true) && !block.has(c.vendorId));

  // vendor preference order -> index map (for tie-breaks/balanced scoring)
  const pref = new Map();
  (opts.preferVendors || []).forEach((id, i) => pref.set(id, i));
  need._vendorPrefIndex = pref;

  // score by strategy
  const scored = pool
    .map((sku) => ({ sku, score: skuScoreForStrategy(strategy, sku, need, opts.pricing?.priceLocks || [], opts.pricing?.loyaltyMultipliers || {}) }))
    .sort((a, b) => b.score - a.score);

  const chosen = scored[0]?.sku || null;
  const alternates = scored.slice(1, 4).map((x) => ({
    vendorId: x.sku.vendorId,
    sku: x.sku.sku,
    name: x.sku.name,
    unitPrice: round2(effectiveUnitPrice(x.sku, opts.pricing?.priceLocks || [], opts.pricing?.loyaltyMultipliers || {})),
    score: round2(x.score),
  }));

  return { chosen, alternates };
}

/* =============================================================================
   Substitutions
============================================================================= */

function trySubstitutions(need, catMap, optionsSubs = []) {
  // rule list like: { for:'baby_spinach', allow:[{key:'spinach', score:0.9}] }
  const rule = (optionsSubs || []).find((r) => keyOf(r.for) === need.key);
  if (!rule) return [];
  const out = [];
  for (const al of rule.allow || []) {
    const cands = catMap.get(keyOf(al.key)) || [];
    cands.forEach((c) => {
      out.push({ sku: c, score: Number(al.score || 0.5), note: al.note });
    });
  }
  // flatten to SKU entries
  return out;
}

/* =============================================================================
   Budgeting
============================================================================= */

function applyBudget(allocs, budget) {
  if (!budget?.weekly && !budget?.hardCap) return { kept: allocs, deferred: [] };

  const essentials = [];
  const staples = [];
  const bulk = [];
  allocs.forEach((a) => {
    const p = a.need.priority || "staple";
    (p === "essential" ? essentials : p === "bulk" ? bulk : staples).push(a);
  });

  const order = [...essentials, ...staples, ...bulk];
  let spend = 0;
  const kept = [];
  const deferred = [];
  for (const a of order) {
    const nextSpend = spend + a.extPrice;
    const overWeekly = budget.weekly ? nextSpend > budget.weekly : false;
    const overHard = budget.hardCap ? nextSpend > budget.hardCap : false;
    if (overHard || overWeekly) deferred.push(a);
    else {
      kept.push(a);
      spend = nextSpend;
    }
  }
  return { kept, deferred };
}

/* =============================================================================
   Pricing: coupons / tax / totals
============================================================================= */

function applyCouponsAndLocks(lines, options) {
  const coupons = options?.pricing?.coupons || [];
  const locks = options?.pricing?.priceLocks || [];
  const taxRate = Number(options?.pricing?.taxRatePct || 0);

  const couponsApplied = [];
  const priceLocksApplied = [];
  const loyaltyBoosts = [];

  // price locks affect unit price (handled in effectiveUnitPrice for scoring),
  // here we mirror for transparency if a lock matches a purchased SKU
  lines.forEach((ln) => {
    const lock = locks.find((l) => l.vendorId === ln.vendorId && l.sku === ln.sku && (!l.expiresISO || dayjs().isBefore(dayjs(l.expiresISO))));
    if (lock) {
      priceLocksApplied.push({ vendorId: ln.vendorId, sku: ln.sku, unitPrice: lock.unitPrice });
      ln.unitPrice = Number(lock.unitPrice) / Math.max(1, ln.packQty);
      ln.extPrice = round2(ln.unitPrice * ln.qty);
    }
  });

  // vendor-bucket coupons
  const byVendor = new Map();
  lines.forEach((ln) => {
    const arr = byVendor.get(ln.vendorId) || [];
    arr.push(ln);
    byVendor.set(ln.vendorId, arr);
  });

  const discountsByVendor = new Map();

  coupons.forEach((c) => {
    let targetVendors = c.vendorId ? [c.vendorId] : Array.from(byVendor.keys());
    targetVendors.forEach((vid) => {
      const vLines = byVendor.get(vid) || [];
      const eligible = c.appliesToSkus?.length ? vLines.filter((l) => c.appliesToSkus.includes(l.sku)) : vLines;
      const subtotal = eligible.reduce((s, l) => s + l.extPrice, 0);
      if (subtotal <= 0) return;
      let value = 0;
      if (c.type === "percent") value = (Number(c.value || 0) / 100) * subtotal;
      else value = Number(c.value || 0);
      value = Math.min(value, subtotal);
      const prev = discountsByVendor.get(vid) || 0;
      discountsByVendor.set(vid, prev + value);
      couponsApplied.push({ vendorId: c.vendorId, code: c.code, value: round2(value) });
    });
  });

  // tax estimated on (subtotal - discounts)
  const estimatedTax = round2(
    Array.from(byVendor.entries()).reduce((acc, [vid, vLines]) => {
      const sub = vLines.reduce((s, l) => s + l.extPrice, 0);
      const disc = discountsByVendor.get(vid) || 0;
      return acc + ((sub - disc) * (taxRate / 100));
    }, 0)
  );

  const estimatedTotal = round2(
    Array.from(byVendor.entries()).reduce((acc, [vid, vLines]) => {
      const sub = vLines.reduce((s, l) => s + l.extPrice, 0);
      const disc = discountsByVendor.get(vid) || 0;
      return acc + (sub - disc);
    }, 0) + estimatedTax
  );

  // loyalty summary
  const mult = options?.pricing?.loyaltyMultipliers || {};
  Object.keys(mult).forEach((vendorId) => {
    loyaltyBoosts.push({ vendorId, multiplier: Number(mult[vendorId]) });
  });

  return {
    discountsByVendor,
    couponsApplied,
    priceLocksApplied,
    loyaltyBoosts,
    estimatedTax,
    estimatedTotal,
  };
}

/* =============================================================================
   Grouping into vendor orders & route planning
============================================================================= */

function bucketByVendor(lines) {
  const map = new Map();
  lines.forEach((l) => {
    const arr = map.get(l.vendorId) || [];
    arr.push(l);
    map.set(l.vendorId, arr);
  });
  return map;
}

function buildOrdersFromLines(lines, vendors, options) {
  const sabbathAware = !!options?.constraints?.sabbathAware;
  const vendorMap = new Map(vendors.map((v) => [v.id, v]));
  const byVendor = bucketByVendor(lines);
  const orders = [];

  for (const [vendorId, vLines] of byVendor.entries()) {
    const v = vendorMap.get(vendorId);
    if (!v || vLines.length === 0) continue;

    const earliestNeed = dayjs.min(...vLines.map((i) => dayjs(i.needBy)));
    let orderDate = computeOrderDateForNeed(earliestNeed, v, sabbathAware);
    orderDate = applyCutoff(orderDate, v);
    const deliveryDate = computeDeliveryFromOrder(orderDate, v, sabbathAware);

    const subtotal = round2(vLines.reduce((s, l) => s + l.extPrice, 0));
    const shipping = Number(v.shippingFlat || 0);

    orders.push({
      id: _uuid(),
      vendorId: v.id,
      vendorName: v.name,
      fulfillment: options?.fulfillment?.mode === "pickup" ? "pickup" : (options?.fulfillment?.mode === "mixed" ? (v.pickupOnly ? "pickup" : "delivery") : "delivery"),
      orderDate: orderDate.toISOString(),
      estDeliveryDate: deliveryDate.toISOString(),
      items: vLines.map((l) => ({
        sku: l.sku,
        name: l.name,
        qty: l.qty,
        unit: l.unit,
        packQty: l.packQty,
        unitPrice: l.unitPrice,
        extPrice: l.extPrice,
        needBy: l.needBy,
        coldChain: !!l.coldChain,
        allergens: l.allergens || [],
        backorderETA: l.backorderETA ?? null,
        inStock: l.inStock !== false,
        alternates: l.alternates || [],
      })),
      shipping,
      subtotal,
      total: round2(subtotal + shipping),
    });
  }

  return orders;
}

/** naive route plan: vendor order of pickups, counts items & cold-chain exposure */
function makeRoutePlan(orders, options) {
  const pickupOrders = orders.filter((o) => o.fulfillment === "pickup");
  if (!pickupOrders.length) return undefined;
  const startAddressId = options?.fulfillment?.routeStartAddressId || "home";
  // Dummy deterministic route = by orderDate ascending
  const stops = pickupOrders
    .sort((a, b) => dayjs(a.orderDate).valueOf() - dayjs(b.orderDate).valueOf())
    .map((o) => ({
      vendorId: o.vendorId,
      addressId: `addr_${o.vendorId}`,
      etaISO: o.orderDate,
      items: o.items.length,
      coldChainBreakMinutes: o.items.some((i) => i.coldChain) ? 15 : 0,
    }));
  return {
    startAddressId,
    stops,
    distanceKm: Math.max(2, stops.length * 3),
    driveTimeMin: Math.max(10, stops.length * 12),
  };
}

/* =============================================================================
   Public API: plan (preferred)
============================================================================= */

/**
 * req: {
 *   demand: [], inventory: {}, vendors: [],
 *   gardenForecast?: [], batching?: { sessionIds?:[], bufferDays?:number },
 *   links?: { mealTimelineRange?: {startISO,endISO} }
 * }
 * options: PlanOptions (see .d.ts)
 */
async function plan(req, options = {}) {
  const audit = [];
  const warnings = [];

  const strategy = options.strategy || "cost_first";

  const inv = normalizeInventory(req.inventory || {});
  const garden = options?.garden?.useForecast === false ? [] : (req.gardenForecast || []);

  // Normalize demand & subtract garden forecast first
  let D = normalizeDemand(req.demand || [], { startDate: req.startDate }, options?.garden?.reserveHomegrownFirst ? garden : []);
  audit.push({ atISO: new Date().toISOString(), action: "normalize_demand", detail: { demandCount: D.length } });

  // Subtract usable inventory (inventory_first strategy favors this step)
  if (strategy === "inventory_first" || options.constraints?.requireInStock) {
    D = D
      .map((d) => {
        const invRow = inv[d.key];
        if (!invRow || !invRow.qty) return d;
        let usable = invRow.qty;
        if (invRow.unit && d.unit && invRow.unit !== d.unit) {
          const conv = convertQty(invRow.qty, invRow.unit, d.unit);
          if (conv != null) usable = conv;
        }
        const remain = Math.max(0, d.qty - usable);
        // reserve what we "took"
        const took = d.qty - remain;
        if (took > 0) {
          invRow.qty = Math.max(0, invRow.qty - (convertQty(took, d.unit, invRow.unit) ?? took));
        }
        return { ...d, qty: remain };
      })
      .filter((d) => d.qty > 0);
    audit.push({ atISO: new Date().toISOString(), action: "inventory_reservation", detail: { remaining: D.length } });
  }

  // Align buy-by with batch sessions if provided
  const bufferDays = Number(req.batching?.bufferDays || 0);
  if (Array.isArray(req.batching?.sessionIds) && req.batching.sessionIds.length) {
    D = D.map((d) => ({ ...d, needBy: dayjs(d.needBy).subtract(bufferDays, "day").toISOString() }));
    audit.push({ atISO: new Date().toISOString(), action: "batch_buffer_applied", detail: { bufferDays } });
  }

  // Build catalog index once
  const catMap = catalogIndex(req.vendors || []);

  // Allocate items to SKUs/vendors
  const allocations = [];
  const unfulfilled = [];
  const substitutionsApplied = [];
  const linesForPricing = [];

  for (const need of D) {
    const directCands = catMap.get(need.key) || [];
    const subs = trySubstitutions(need, catMap, options.substitutions);
    const pool = [...directCands, ...subs.map((s) => s.sku)];

    const { chosen, alternates } = chooseSkuForNeed(need, pool, strategy, {
      vendors: req.vendors,
      constraints: options.constraints || {},
      preferVendors: options?.fulfillment?.consolidateVendors ? (options.preferVendors || []) : (options.preferVendors || []),
      pricing: options.pricing || {},
    });

    if (!chosen) {
      unfulfilled.push({
        demandKey: need.id,
        name: need.name,
        unit: need.unit,
        qty: need.qty,
        reason: options.constraints?.requireInStock ? "no_stock" : "unknown",
        suggestions: ["Try widening substitutions", "Remove vendor blocklist", "Adjust unit or allow conversion"],
      });
      continue;
    }

    // Pack math
    let needInSkuUnit = need.qty;
    if (need.unit && chosen.unit && need.unit !== chosen.unit) {
      const conv = convertQty(need.qty, need.unit, chosen.unit);
      if (conv == null) {
        unfulfilled.push({
          demandKey: need.id,
          name: need.name,
          unit: need.unit,
          qty: need.qty,
          reason: `unit_mismatch_${need.unit}_to_${chosen.unit}`,
        });
        continue;
      }
      needInSkuUnit = conv;
    }
    const packs = Math.max(1, Math.ceil(needInSkuUnit / Math.max(1, chosen.packQty)));
    const qty = packs * Math.max(1, chosen.packQty);
    const unitPrice = round2(effectiveUnitPrice(chosen, options.pricing?.priceLocks || [], options.pricing?.loyaltyMultipliers || {}));
    const extPrice = round2(unitPrice * qty);

    const line = {
      id: _uuid(),
      demandKey: need.id,
      vendorId: chosen.vendorId,
      vendorName: chosen.vendorName,
      sku: chosen.sku,
      name: chosen.name,
      unit: chosen.unit,
      qty,
      packQty: chosen.packQty || 1,
      unitPrice,
      extPrice,
      needBy: need.needBy,
      isSubstitution: !directCands.includes(chosen),
      substitutedFor: !directCands.includes(chosen) ? need.key : undefined,
      notes: [],
      coldChain: /milk|cream|meat|fish|yogurt|cheese|egg/.test(keyOf(chosen.name)),
      allergens: [], // could propagate from catalog if available
      backorderETA: null,
      inStock: chosen.inStock !== false,
      alternates,
    };

    if (line.isSubstitution) {
      substitutionsApplied.push({
        forName: need.name,
        suggestion: { vendorId: chosen.vendorId, sku: chosen.sku, name: chosen.name, unit: chosen.unit, packQty: chosen.packQty, price: unitPrice * (chosen.packQty || 1) },
      });
      audit.push({ atISO: new Date().toISOString(), action: "substitution_applied", detail: { for: need.key, to: chosen.sku } });
    }

    allocations.push({ need, line });
    linesForPricing.push(line);
  }

  // Budget & constraints (defer over cap)
  const { kept, deferred } = applyBudget(
    allocations.map((a) => ({ ...a.line, need: a.need })),
    options.constraints?.budget || req.budget
  );

  // Build orders from kept lines
  const purchaseOrders = buildOrdersFromLines(kept, req.vendors || [], {
    fulfillment: options.fulfillment || { mode: "delivery" },
    constraints: options.constraints || {},
  });

  // Pricing summary (coupons/locks/tax)
  const pricingSummary = applyCouponsAndLocks(kept, options);

  // Derive vendors array for Enhanced response
  const vendorsOut = purchaseOrders.map((po) => {
    const sub = po.subtotal;
    const vendorDiscount = pricingSummary.discountsByVendor.get(po.vendorId) || 0;
    const taxShare =
      pricingSummary.estimatedTax *
      (sub ? sub / kept.reduce((s, l) => s + l.extPrice, 0) : 0);
    return {
      vendorId: po.vendorId,
      vendorName: po.vendorName,
      fulfillment: po.fulfillment,
      etaISO: po.estDeliveryDate,
      subtotal: sub,
      tax: round2(taxShare),
      discounts: round2(vendorDiscount),
      total: round2(sub - vendorDiscount + (po.shipping || 0) + taxShare),
      lines: po.items.map((it) => {
        const src = kept.find((l) => l.sku === it.sku && l.vendorId === po.vendorId);
        return {
          id: _uuid(),
          demandKey: src?.demandKey || "",
          sku: it.sku,
          name: it.name,
          unit: it.unit,
          qty: it.qty,
          unitPrice: it.unitPrice,
          lineTotal: it.extPrice,
          isSubstitution: !!src?.isSubstitution,
          substitutedFor: src?.substitutedFor,
          notes: src?.notes || [],
          coldChain: !!src?.coldChain,
          allergens: src?.allergens || [],
          backorderETA: src?.backorderETA ?? null,
          inStock: src?.inStock !== false,
          alternates: src?.alternates || [],
        };
      }),
    };
  });

  // Route plan for pickups (if any)
  const route = makeRoutePlan(purchaseOrders, { fulfillment: options.fulfillment || {} });

  // Tasks (place/receive)
  const tasks = [];
  purchaseOrders.forEach((po) => {
    tasks.push(
      { title: `Place order: ${po.vendorName}`, when: po.orderDate, meta: { vendorId: po.vendorId, poId: po.id } },
      { title: `Receive & stock: ${po.vendorName}`, when: po.estDeliveryDate, meta: { vendorId: po.vendorId, poId: po.id } }
    );
  });
  if (deferred.length) {
    tasks.push({ title: `Review deferred items (${deferred.length})`, when: dayjs().add(1, "day").toISOString(), meta: { reason: "budget" } });
  }

  // Deltas summary
  const deltas = {
    fromInventory: [], // If you track reservations above, populate here
    fromGarden: [],    // Already subtracted; you can echo lots used if you want
    toBuy: kept.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit })),
  };

  // Week buckets
  const weekBuckets = purchaseOrders.reduce((map, po) => {
    const wk = dayjs(po.estDeliveryDate).format(WEEK_FMT);
    map.set(wk, round2((map.get(wk) || 0) + po.total));
    return map;
  }, new Map());
  const weekBucketsArr = [...weekBuckets.entries()].map(([week, spend]) => ({ week, spend }));

  const response = {
    // Enhanced fields (see .d.ts)
    vendors: vendorsOut,
    unfulfilled,
    deltas,
    route,
    pricingSummary,
    links: {
      mealTimelineRange: req.links?.mealTimelineRange,
      batchSessions: Array.isArray(req.batching?.sessionIds)
        ? req.batching.sessionIds.map((sid) => ({
            sessionId: sid,
            buyByISO: dayjs().toISOString(),
          }))
        : [],
    },
    audit,
    warnings,
    version: VERSION,

    // Also surface classic-looking fields for legacy UI bits:
    purchaseOrders,
    backorders: unfulfilled.map((u) => ({ name: u.name, qty: u.qty, unit: u.unit, reason: u.reason })),
    substitutions: substitutionsApplied,
    tasks,
    deferred,
    summary: {
      spend: round2(purchaseOrders.reduce((s, po) => s + po.total, 0)),
      items: purchaseOrders.reduce((s, po) => s + po.items.length, 0),
      vendors: purchaseOrders.length,
      weekBuckets: weekBucketsArr,
    },
  };

  return response;
}

/* =============================================================================
   Legacy wrapper: scheduleProcurement -> plan
============================================================================= */

/**
 * Legacy adapter that returns a compatible subset of the enhanced response.
 * @param {Object} args
 *  - demand, inventory, vendors, opts
 */
async function scheduleProcurement({ demand = [], inventory = {}, vendors = [], opts = {} } = {}) {
  const req = {
    demand,
    inventory,
    vendors,
    startDate: opts.startDate,
    gardenForecast: opts.gardenForecast || [],
    batching: opts.batching || undefined,
    links: opts.links || undefined,
  };
  const options = {
    strategy: opts.strategy || "cost_first",
    constraints: {
      budget: opts.budget,
      sabbathAware: !!opts.sabbathAware,
      vendorAllowlist: opts.vendorAllowlist || [],
      vendorBlocklist: opts.vendorBlocklist || [],
      requireInStock: opts.requireInStock || false,
      preferInStock: opts.preferInStock || false,
      deliveryWindows: opts.deliveryWindows || [],
    },
    substitutions: opts.substitutions || [],
    pricing: opts.pricing || {},
    fulfillment: {
      mode: opts.fulfillmentMode || "delivery",
      consolidateVendors: !!opts.consolidateVendors,
      routeStartAddressId: opts.routeStartAddressId,
    },
    garden: {
      useForecast: opts.useGardenForecast !== false,
      reserveHomegrownFirst: !!opts.reserveHomegrownFirst,
    },
    meta: { versionTag: opts.versionTag, seed: opts.seed, includeAlternatesInOutput: true },
  };

  const res = await plan(req, options);

  // Preserve previous return envelope keys
  return {
    purchaseOrders: res.purchaseOrders,
    backorders: res.backorders,
    substitutions: res.substitutions,
    tasks: res.tasks,
    deferred: res.deferred,
    summary: res.summary,
  };
}

/* =============================================================================
   Exports
============================================================================= */

module.exports = {
  plan,
  scheduleProcurement,

  // Expose helpers for tests/extensibility
  _internals: {
    keyOf,
    convertQty,
    bestUnitMatch,
    catalogIndex,
    chooseSkuForNeed: skuScoreForStrategy, // scoring core
    normalizeDemand,
    normalizeInventory,
    nextAllowedDeliveryDay,
    computeOrderDateForNeed,
    buildOrdersFromLines,
    applyCouponsAndLocks,
  },
};
